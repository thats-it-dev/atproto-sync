/**
 * IndexStore backed by a JSON file inside the vault (<vault>/.atpsync/index.json),
 * replacing the Obsidian plugin's per-vault IndexedDB store. Atomic write via
 * write-to-tmp-then-rename so a mid-write crash never corrupts the index.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { IndexStore } from '@atproto-sync/core/sync/engine';
import type { IndexEntry } from '@atproto-sync/core/sync/reconcile';

function isIndexEntry(value: unknown): value is IndexEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.path === 'string' &&
    typeof e.rkey === 'string' &&
    typeof e.baseContent === 'string' &&
    typeof e.lastCid === 'string'
  );
}

export class FsIndexStore implements IndexStore {
  constructor(private readonly indexPath: string) {}

  async load(): Promise<IndexEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.indexPath, 'utf8');
    } catch {
      return []; // first run or unreadable -> start fresh
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isIndexEntry);
  }

  async save(entries: IndexEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
    const tmp = `${this.indexPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8');
    await fs.rename(tmp, this.indexPath);
  }
}
