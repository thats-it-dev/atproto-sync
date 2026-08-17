import { App, TFile, normalizePath } from 'obsidian';
import type { VaultAdapter } from '../sync/engine';
import type { LocalFile } from '../sync/reconcile';
import { sha256Hex } from '../lexicon/build';
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
