import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { IndexedDbStore } from '../../src/obsidian/store';

const entry = (path: string, rkey: string) => ({
  path,
  rkey,
  baseContent: `content of ${path}`,
  lastCid: `cid-${rkey}`,
});

describe('IndexedDbStore', () => {
  it('round-trips index entries', async () => {
    const store = new IndexedDbStore('vault-roundtrip');
    await store.save([entry('a.md', 'r1'), entry('b.md', 'r2')]);
    expect(await store.load()).toEqual([entry('a.md', 'r1'), entry('b.md', 'r2')]);
  });

  it('loads an empty array from a fresh database', async () => {
    const store = new IndexedDbStore('vault-empty');
    expect(await store.load()).toEqual([]);
  });

  it('round-trips the settings blob', async () => {
    const store = new IndexedDbStore('vault-settings');
    expect(await store.loadSettings()).toBeNull();
    await store.saveSettings({ interval: 300, wrappedMasterKey: 'abc' });
    expect(await store.loadSettings()).toEqual({ interval: 300, wrappedMasterKey: 'abc' });
  });

  it('skips corrupted entries with a warning instead of crashing', async () => {
    const store = new IndexedDbStore('vault-corrupt');
    await store.save([entry('a.md', 'r1')]);
    // Corrupt the stored array behind the store's back.
    await store.saveRaw('index', [entry('a.md', 'r1'), { path: 42, nonsense: true }, null]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await store.load()).toEqual([entry('a.md', 'r1')]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
