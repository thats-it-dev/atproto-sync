/**
 * VaultAdapter backed by a plain directory on disk, so the sync engine can run
 * without Obsidian. Paths are NFC-normalized relative POSIX-style paths, the
 * same contract ObsidianVaultAdapter honours.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { sha256Hex } from '../src/lexicon/build';
import { isIgnored } from '../src/obsidian/ignore';
import type { VaultAdapter } from '../src/sync/engine';
import type { LocalFile, RenameHint } from '../src/sync/reconcile';

const MARKDOWN_RE = /\.md$/i;

export function isMarkdownPath(relPath: string): boolean {
  return MARKDOWN_RE.test(relPath);
}

/** Relative POSIX path -> absolute fs path under root, rejecting escapes out of root. */
export function resolveInsideVault(root: string, relPath: string): string {
  const norm = path.posix.normalize(relPath.normalize('NFC'));
  if (norm.startsWith('..') || path.isAbsolute(norm)) {
    throw new Error(`Unsafe vault path: ${relPath}`);
  }
  return path.join(root, ...norm.split('/'));
}

export class FsVaultAdapter implements VaultAdapter {
  /**
   * sha256 cache keyed by path|mtimeMs|size so unchanged attachments hash once.
   * Rebuilt on every readAllAttachments pass so it only ever holds entries for
   * attachments that still exist (edited or deleted files drop out).
   */
  private hashCache = new Map<string, string>();

  /** Number of cached attachment hashes (for tests / diagnostics). */
  get attachmentCacheSize(): number {
    return this.hashCache.size;
  }

  /**
   * @param inodeStatePath Where to persist the path -> file identity map that
   *   rename detection compares against (see takeRenames). Omit to keep it in memory
   *   only, which still catches renames within one process lifetime.
   */
  constructor(
    private readonly root: string,
    private readonly ignorePatterns: () => string[],
    private readonly inodeStatePath?: string,
  ) {}

  private toAbs(relPath: string): string {
    return resolveInsideVault(this.root, relPath);
  }

  private toRel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/').normalize('NFC');
  }

  private async *walk(dir: string): AsyncGenerator<string> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing/unreadable dir
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Skip ignored directories outright (.git, node_modules, ...) instead of
        // walking and stat'ing everything beneath them. Prefix patterns match
        // "<dir>/"; file globs like "*.tmp" never match a trailing slash.
        if (isIgnored(`${this.toRel(full)}/`, this.ignorePatterns())) continue;
        yield* this.walk(full);
      } else if (ent.isFile()) {
        yield full;
      }
    }
  }

  async readAll(): Promise<LocalFile[]> {
    const out: LocalFile[] = [];
    for await (const abs of this.walk(this.root)) {
      const rel = this.toRel(abs);
      if (!MARKDOWN_RE.test(rel)) continue;
      if (isIgnored(rel, this.ignorePatterns())) continue;
      out.push({ path: rel, content: await fs.readFile(abs, 'utf8') });
    }
    return out;
  }

  async readAllAttachments(): Promise<Array<{ path: string; hash: string; size: number }>> {
    const out: Array<{ path: string; hash: string; size: number }> = [];
    const next = new Map<string, string>();
    for await (const abs of this.walk(this.root)) {
      const rel = this.toRel(abs);
      if (MARKDOWN_RE.test(rel)) continue;
      if (isIgnored(rel, this.ignorePatterns())) continue;
      const stat = await fs.stat(abs);
      const cacheKey = `${rel}|${stat.mtimeMs}|${stat.size}`;
      let hash = this.hashCache.get(cacheKey);
      if (!hash) {
        const bytes = new Uint8Array(await fs.readFile(abs));
        hash = await sha256Hex(bytes);
      }
      next.set(cacheKey, hash);
      out.push({ path: rel, hash, size: stat.size });
    }
    this.hashCache = next;
    return out;
  }

  async write(relPath: string, content: string): Promise<void> {
    const abs = this.toAbs(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  async remove(relPath: string): Promise<void> {
    const abs = this.toAbs(relPath);
    await fs.rm(abs, { force: true });
    await this.pruneEmptyDirs(path.dirname(abs));
  }

  /** Remove now-empty directories above a deleted file, stopping at the vault root. */
  private async pruneEmptyDirs(dir: string): Promise<void> {
    const root = path.resolve(this.root);
    let current = path.resolve(dir);
    while (current !== root && current.startsWith(root + path.sep)) {
      try {
        await fs.rmdir(current); // fails on anything but an empty directory
      } catch {
        return;
      }
      current = path.dirname(current);
    }
  }

  /** Last known path -> file identity (inode:birthtime) map, or null before the first load. */
  private inodes: Map<string, string> | null = null;

  private async loadInodes(): Promise<Map<string, string> | null> {
    if (this.inodes) return this.inodes;
    if (!this.inodeStatePath) return null;
    try {
      const parsed = JSON.parse(await fs.readFile(this.inodeStatePath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const map = new Map<string, string>();
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string') map.set(k, v);
        }
        return map;
      }
    } catch {
      // first run or unreadable: no history to compare against
    }
    return null;
  }

  private async saveInodes(map: Map<string, string>): Promise<void> {
    this.inodes = map;
    if (!this.inodeStatePath) return;
    await fs.mkdir(path.dirname(this.inodeStatePath), { recursive: true });
    const tmp = `${this.inodeStatePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(map), null, 2), 'utf8');
    await fs.rename(tmp, this.inodeStatePath);
  }

  /**
   * Infer local renames from file identity: a path from the last pass that is
   * gone, whose file now sits at a path we had not seen, moved there. fs.watch
   * cannot tell us old -> new, and content matching fails once a moved file
   * is also edited; inode + birth time survive both the move and the edit,
   * and the birth time rules out an inode the filesystem recycled for a new
   * file (common on ext4 right after a delete). Folder renames surface as one
   * hint per file beneath them.
   */
  async takeRenames(): Promise<RenameHint[]> {
    const previous = await this.loadInodes();
    const current = new Map<string, string>();
    const byInode = new Map<string, string>();
    for await (const abs of this.walk(this.root)) {
      const rel = this.toRel(abs);
      if (isIgnored(rel, this.ignorePatterns())) continue;
      let ino: string;
      try {
        const st = await fs.stat(abs, { bigint: true });
        ino = `${st.ino}:${st.birthtimeNs}`;
      } catch {
        continue; // vanished mid-walk
      }
      current.set(rel, ino);
      byInode.set(ino, rel);
    }
    const hints: RenameHint[] = [];
    if (previous) {
      for (const [oldPath, ino] of previous) {
        if (current.has(oldPath)) continue;
        const newPath = byInode.get(ino);
        if (!newPath || previous.has(newPath)) continue;
        hints.push({ from: oldPath, to: newPath });
      }
    }
    let changed = !previous || previous.size !== current.size;
    if (!changed) {
      for (const [p, ino] of current) {
        if (previous!.get(p) !== ino) {
          changed = true;
          break;
        }
      }
    }
    if (changed) await this.saveInodes(current);
    return hints;
  }

  async readBinary(relPath: string): Promise<Uint8Array> {
    const bytes = await fs.readFile(this.toAbs(relPath));
    return new Uint8Array(bytes);
  }

  async writeBinary(relPath: string, bytes: Uint8Array): Promise<void> {
    const abs = this.toAbs(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
  }

  /** Count markdown files without reading their contents (cheap status probe). */
  async countMarkdown(): Promise<number> {
    let n = 0;
    for await (const abs of this.walk(this.root)) {
      const rel = this.toRel(abs);
      if (!MARKDOWN_RE.test(rel)) continue;
      if (isIgnored(rel, this.ignorePatterns())) continue;
      n++;
    }
    return n;
  }
}
