import { App, TFile, normalizePath } from 'obsidian';
import type { VaultAdapter } from '../sync/engine';
import type { LocalFile } from '../sync/reconcile';
import { isIgnored } from './ignore';

/** VaultAdapter over the Obsidian vault. All paths NFC-normalize at this boundary. */
export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(
    private readonly app: App,
    private readonly ignorePatterns: () => string[]
  ) {}

  async readAll(): Promise<LocalFile[]> {
    const out: LocalFile[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const path = file.path.normalize('NFC');
      if (isIgnored(path, this.ignorePatterns())) continue;
      out.push({ path, content: await this.app.vault.cachedRead(file) });
    }
    return out;
  }

  async write(path: string, content: string): Promise<void> {
    const p = normalizePath(path.normalize('NFC'));
    const existing = this.app.vault.getAbstractFileByPath(p);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return;
    }
    const dir = p.split('/').slice(0, -1).join('/');
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
      // createFolder throws if a parent exists; nested creation is fine to race.
      await this.app.vault.createFolder(dir).catch(() => {});
    }
    await this.app.vault.create(p, content);
  }

  async remove(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path.normalize('NFC')));
    if (file) {
      await this.app.vault.trash(file, true); // system trash: recoverable
    }
  }
}
