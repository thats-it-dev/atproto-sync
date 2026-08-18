import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import { ATTACHMENT_COLLECTION, NOTE_COLLECTION, slugify } from '../lexicon/build';
import type { AttachmentMetaPlaintext, AttachmentRecord, NoteRecord, PlaintextContent } from '../lexicon/types';
import { isEncrypted } from '../lexicon/build';
import {
  extractEmbedTargets,
  isPublicNote,
  removePublicFlag,
  setPublicFlag,
} from '../publish/frontmatter';
import type AtprotoSyncPlugin from './main';

export function registerPublishCommands(plugin: AtprotoSyncPlugin): void {
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
          .setTitle('ATProto Sync: toggle public')
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

async function promptMakePublic(plugin: AtprotoSyncPlugin, file: TFile): Promise<void> {
  const content = await plugin.app.vault.read(file);
  new MakePublicModal(plugin.app, file, content, async (slug) => {
    await plugin.app.vault.modify(file, setPublicFlag(content, slug));
    new Notice(`ATProto Sync: "${file.basename}" is now public.`);
    await plugin.runSync(true);
  }).open();
}

async function makePrivate(plugin: AtprotoSyncPlugin, file: TFile): Promise<void> {
  const content = await plugin.app.vault.read(file);
  if (!isPublicNote(content)) {
    new Notice('ATProto Sync: this note is not public.');
    return;
  }
  // Engine encryption always generates a fresh note key, so republishing
  // after this edit rotates the key as required.
  await plugin.app.vault.modify(file, removePublicFlag(content));
  new Notice(`ATProto Sync: "${file.basename}" is private again.`);
  await plugin.runSync(true);
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
        text: `Embedded attachments published unencrypted with it: ${embeds.join(', ')}`,
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

async function reviewPublicNotes(plugin: AtprotoSyncPlugin): Promise<void> {
  if (!plugin.pdsClient) {
    new Notice('ATProto Sync: connect to your PDS first.');
    return;
  }
  const records = await plugin.pdsClient.listRecords(NOTE_COLLECTION);
  const publicNotes = records
    .map((r) => r.value as NoteRecord)
    .filter((v) => !isEncrypted(v.content))
    .map((v) => v.content as PlaintextContent);
  const attachmentRecords = await plugin.pdsClient.listRecords(ATTACHMENT_COLLECTION);
  const publicAttachments = attachmentRecords
    .map((r) => r.value as AttachmentRecord)
    .filter((v) => !('ciphertext' in v.meta))
    .map((v) => v.meta as AttachmentMetaPlaintext);
  new ReviewPublicModal(plugin, publicNotes, publicAttachments).open();
}

class ReviewPublicModal extends Modal {
  constructor(
    private readonly plugin: AtprotoSyncPlugin,
    private readonly notes: PlaintextContent[],
    private readonly attachments: AttachmentMetaPlaintext[]
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Public notes' });
    if (this.notes.length === 0 && this.attachments.length === 0) {
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
              new Notice(`ATProto Sync: local file not found for ${note.path}; sync first.`);
            }
          })
        );
    }
    if (this.attachments.length > 0) {
      contentEl.createEl('h3', { text: 'Public attachments' });
      contentEl.createEl('p', {
        text: 'Public because a public note embeds them; they re-encrypt automatically when those notes go private.',
      });
      for (const att of this.attachments) {
        new Setting(contentEl).setName(att.path).setDesc(att.mimeType);
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
