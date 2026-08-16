import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import { NOTE_COLLECTION, slugify } from '../lexicon/build';
import type { NoteRecord, PlaintextContent } from '../lexicon/types';
import { isEncrypted } from '../lexicon/build';
import {
  extractEmbedTargets,
  isPublicNote,
  removePublicFlag,
  setPublicFlag,
} from '../publish/frontmatter';
import type NoteskyPlugin from './main';

export function registerPublishCommands(plugin: NoteskyPlugin): void {
  plugin.addCommand({
    id: 'make-note-public',
    name: 'Make note public',
    checkCallback: (checking) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') return false;
      if (!checking) void promptMakePublic(plugin, file);
      return true;
    },
  });

  plugin.addCommand({
    id: 'make-note-private',
    name: 'Make note private',
    checkCallback: (checking) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') return false;
      if (!checking) void makePrivate(plugin, file);
      return true;
    },
  });

  plugin.addCommand({
    id: 'review-public-notes',
    name: 'Review public notes',
    callback: () => void reviewPublicNotes(plugin),
  });

  plugin.registerEvent(
    plugin.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      menu.addItem((item) =>
        item
          .setTitle('Notesky: toggle public')
          .setIcon('globe')
          .onClick(async () => {
            const content = await plugin.app.vault.read(file);
            if (isPublicNote(content)) await makePrivate(plugin, file);
            else await promptMakePublic(plugin, file);
          })
      );
    })
  );
}

async function promptMakePublic(plugin: NoteskyPlugin, file: TFile): Promise<void> {
  const content = await plugin.app.vault.read(file);
  new MakePublicModal(plugin.app, file, content, async (slug) => {
    await plugin.app.vault.modify(file, setPublicFlag(content, slug));
    new Notice(`Notesky: "${file.basename}" is now public.`);
    await plugin.runSync();
  }).open();
}

async function makePrivate(plugin: NoteskyPlugin, file: TFile): Promise<void> {
  const content = await plugin.app.vault.read(file);
  if (!isPublicNote(content)) {
    new Notice('Notesky: this note is not public.');
    return;
  }
  // Engine encryption always generates a fresh note key, so republishing
  // after this edit rotates the key as required.
  await plugin.app.vault.modify(file, removePublicFlag(content));
  new Notice(`Notesky: "${file.basename}" is private again.`);
  await plugin.runSync();
}

class MakePublicModal extends Modal {
  private slug: string;

  constructor(
    app: App,
    private readonly file: TFile,
    private readonly content: string,
    private readonly onConfirm: (slug: string) => Promise<void>
  ) {
    super(app);
    this.slug = slugify(file.basename);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: `Make "${this.file.basename}" public?` });
    contentEl.createEl('p', {
      text: 'The following will be readable by anyone, unencrypted, on your PDS:',
    });
    const ul = contentEl.createEl('ul');
    ul.createEl('li', { text: `Title: ${this.file.basename}` });
    ul.createEl('li', { text: 'The full note text' });
    const embeds = extractEmbedTargets(this.content);
    if (embeds.length > 0) {
      ul.createEl('li', {
        text: `Embedded attachments that will become public with it: ${embeds.join(', ')}`,
      });
    }

    new Setting(contentEl)
      .setName('Public slug')
      .setDesc('Used in public URLs.')
      .addText((t) => t.setValue(this.slug).onChange((v) => (this.slug = v)));

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText('Make public')
          .setCta()
          .onClick(async () => {
            this.close();
            await this.onConfirm(slugify(this.slug) || slugify(this.file.basename));
          })
      )
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

async function reviewPublicNotes(plugin: NoteskyPlugin): Promise<void> {
  if (!plugin.pdsClient) {
    new Notice('Notesky: connect to your PDS first.');
    return;
  }
  const records = await plugin.pdsClient.listRecords(NOTE_COLLECTION);
  const publicNotes = records
    .map((r) => r.value as NoteRecord)
    .filter((v) => !isEncrypted(v.content))
    .map((v) => v.content as PlaintextContent);
  new ReviewPublicModal(plugin, publicNotes).open();
}

class ReviewPublicModal extends Modal {
  constructor(
    private readonly plugin: NoteskyPlugin,
    private readonly notes: PlaintextContent[]
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Public notes' });
    if (this.notes.length === 0) {
      contentEl.createEl('p', { text: 'No public notes. Everything is encrypted.' });
      return;
    }
    for (const note of this.notes) {
      new Setting(contentEl)
        .setName(note.title)
        .setDesc(`${note.path} · /${note.slug}`)
        .addButton((b) =>
          b.setButtonText('Make private').setWarning().onClick(async () => {
            const file = this.plugin.app.vault.getAbstractFileByPath(note.path);
            if (file instanceof TFile) {
              await makePrivate(this.plugin, file);
              this.close();
            } else {
              new Notice(`Notesky: local file not found for ${note.path}; sync first.`);
            }
          })
        );
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
