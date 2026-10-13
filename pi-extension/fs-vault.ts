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
import type { LocalFile } from '../src/sync/reconcile';

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

  constructor(
    private readonly root: string,
    private readonly ignorePatterns: () => string[],
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
    await fs.rm(this.toAbs(relPath), { force: true });
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
