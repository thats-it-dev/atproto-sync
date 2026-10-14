import { App, TFile, TFolder, normalizePath } from 'obsidian';
import type { VaultAdapter } from '@atproto-sync/core/sync/engine';
import type { LocalFile, RenameHint } from '@atproto-sync/core/sync/reconcile';
import { sha256Hex } from '@atproto-sync/core/lexicon/build';
import { isIgnored } from '@atproto-sync/core/sync/ignore';

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
    const p = normalizePath(path.normalize('NFC'));
    const file = this.app.vault.getAbstractFileByPath(p);
    if (file) {
      await this.app.fileManager.trashFile(file); // respects the user's deletion preference
    }
    await this.pruneEmptyFolders(p);
  }

  /**
   * Remove the now-empty folders above a deleted file so a folder deleted or
   * renamed on another device disappears here too. A folder counts as empty
   * when it has no subfolders and only hidden files (e.g. .DS_Store) left,
   * which go to the trash with it; the vault root is never touched.
   */
  private async pruneEmptyFolders(filePath: string): Promise<void> {
    const parts = filePath.split('/');
    for (let depth = parts.length - 1; depth >= 1; depth--) {
      const dir = parts.slice(0, depth).join('/');
      const folder = this.app.vault.getAbstractFileByPath(dir);
      if (!(folder instanceof TFolder) || folder.isRoot()) return;
      let listing: { files: string[]; folders: string[] };
      try {
        listing = await this.app.vault.adapter.list(dir);
      } catch {
        return;
      }
      const onlyHidden = listing.files.every((f) => (f.split('/').pop() ?? f).startsWith('.'));
      if (listing.folders.length > 0 || !onlyHidden) return;
      try {
        await this.app.fileManager.trashFile(folder);
      } catch {
        return; // leave it; nothing else depends on this
      }
    }
  }

  private pendingRenames: RenameHint[] = [];

  /**
   * Record a vault `rename` event (file or folder). Paths NFC-normalize here;
   * the engine drains them at the start of the next sync.
   */
  noteRename(oldPath: string, newPath: string): void {
    const from = normalizePath(oldPath.normalize('NFC'));
    const to = normalizePath(newPath.normalize('NFC'));
    if (from === to) return;
    this.pendingRenames.push({ from, to });
  }

  async takeRenames(): Promise<RenameHint[]> {
    const out = this.pendingRenames;
    this.pendingRenames = [];
    return out;
  }

  /** sha256 cache keyed by path|mtime|size so unchanged files hash once. */
  private hashCache = new Map<string, string>();

  async readAllAttachments(): Promise<Array<{ path: string; hash: string; size: number }>> {
    const out: Array<{ path: string; hash: string; size: number }> = [];
    for (const file of this.app.vault.getFiles()) {
      if (file.extension === 'md') continue;
      const path = file.path.normalize('NFC');
      if (isIgnored(path, this.ignorePatterns())) continue;
      const cacheKey = `${path}|${file.stat.mtime}|${file.stat.size}`;
      let hash = this.hashCache.get(cacheKey);
      if (!hash) {
        const bytes = new Uint8Array(await this.app.vault.readBinary(file));
        hash = await sha256Hex(bytes);
        this.hashCache.set(cacheKey, hash);
      }
      out.push({ path, hash, size: file.stat.size });
    }
    return out;
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path.normalize('NFC')));
    if (!(file instanceof TFile)) throw new Error(`no file at ${path}`);
    return new Uint8Array(await this.app.vault.readBinary(file));
  }

  async writeBinary(path: string, bytes: Uint8Array): Promise<void> {
    const p = normalizePath(path.normalize('NFC'));
    const existing = this.app.vault.getAbstractFileByPath(p);
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, buffer);
      return;
    }
    const dir = p.split('/').slice(0, -1).join('/');
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
      await this.app.vault.createFolder(dir).catch(() => {});
    }
    await this.app.vault.createBinary(p, buffer);
  }
}
