import { SyncEngine, VaultAdapter, IndexStore, SyncEngineOptions } from '../../src/sync/engine';
import type { IndexEntry } from '../../src/sync/reconcile';
import type { PdsClient } from '../../src/sync/pds';

/** In-memory VaultAdapter for tests, with a read helper. */
export class FakeVault implements VaultAdapter {
  files = new Map<string, string>();

  async readAll(): Promise<Array<{ path: string; content: string }>> {
    return [...this.files.entries()].map(([path, content]) => ({ path, content }));
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async read(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
}

/** In-memory IndexStore for tests. */
export class FakeIndexStore implements IndexStore {
  entries: IndexEntry[] = [];

  async load(): Promise<IndexEntry[]> {
    return this.entries.map((e) => ({ ...e }));
  }

  async save(entries: IndexEntry[]): Promise<void> {
    this.entries = entries.map((e) => ({ ...e }));
  }
}

export interface TestDevice {
  engine: SyncEngine;
  vault: FakeVault;
  index: FakeIndexStore;
}

let rkeyCounter = 0;

/** Deterministic, sortable rkeys so scenario/fuzz failures reproduce exactly. */
function testRkey(): string {
  return `r${(rkeyCounter++).toString(36).padStart(8, '0')}`;
}

export function makeEngine(
  pds: PdsClient,
  masterKey: Uint8Array,
  options: Partial<SyncEngineOptions> = {}
): TestDevice {
  const vault = new FakeVault();
  const index = new FakeIndexStore();
  const engine = new SyncEngine({
    pds,
    vault,
    index,
    masterKey,
    vaultRkey: 'test-vault',
    rkeyGen: testRkey,
    ...options,
  });
  return { engine, vault, index };
}
