import { describe, it, expect } from 'vitest';
// `obsidian` ships types only; vitest.config.mts aliases it to tests/obsidian/obsidian-stub.ts.
import { TFile, TFolder } from 'obsidian';
import { ObsidianVaultAdapter } from '../../src/obsidian/vault-adapter';

const tfile = (path: string) => Object.assign(new TFile(), { path });
const tfolder = (path: string) => Object.assign(new TFolder(), { path });

/** Minimal vault: a set of file paths plus hidden files; folders are implied by paths. */
function fakeApp(files: string[], hidden: string[] = []) {
  const all = new Set([...files, ...hidden]);
  const trashed: string[] = [];
  // Folders persist after their last file goes, as in a real vault.
  const folderSet = new Set<string>();
  for (const f of all) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) folderSet.add(parts.slice(0, i).join('/'));
  }
  const folders = () => folderSet;
  const app = {
    vault: {
      getAbstractFileByPath(p: string) {
        if (p === '' || p === '/') return tfolder('/');
        if (all.has(p)) return tfile(p);
        if (folders().has(p)) return tfolder(p);
        return null;
      },
      adapter: {
        async list(dir: string) {
          const prefix = `${dir}/`;
          const fs: string[] = [];
          const ds = new Set<string>();
          for (const f of all) {
            if (!f.startsWith(prefix)) continue;
            const rest = f.slice(prefix.length);
            if (rest.includes('/')) ds.add(prefix + rest.split('/')[0]);
            else fs.push(f);
          }
          return { files: fs, folders: [...ds] };
        },
      },
    },
    fileManager: {
      async trashFile(file: { path: string }) {
        trashed.push(file.path);
        for (const f of [...all]) {
          if (f === file.path || f.startsWith(`${file.path}/`)) all.delete(f);
        }
        for (const d of [...folderSet]) {
          if (d === file.path || d.startsWith(`${file.path}/`)) folderSet.delete(d);
        }
      },
    },
  };
  return { app, trashed, all };
}

describe('ObsidianVaultAdapter.remove', () => {
  it('trashes the file and then every folder it left empty, stopping at a non-empty one', async () => {
    const { app, trashed } = fakeApp(['A/B/C/x.md', 'A/keep.md']);
    const adapter = new ObsidianVaultAdapter(app as never, () => []);
    await adapter.remove('A/B/C/x.md');
    expect(trashed).toEqual(['A/B/C/x.md', 'A/B/C', 'A/B']);
  });

  it('treats a folder holding only hidden files as empty and never touches the root', async () => {
    const { app, trashed } = fakeApp(['Old/n.md'], ['Old/.DS_Store']);
    const adapter = new ObsidianVaultAdapter(app as never, () => []);
    await adapter.remove('Old/n.md');
    expect(trashed).toEqual(['Old/n.md', 'Old']);
  });

  it('keeps a folder that still has a subfolder (even a hidden one)', async () => {
    const { app, trashed } = fakeApp(['Old/n.md'], ['Old/.git/config']);
    const adapter = new ObsidianVaultAdapter(app as never, () => []);
    await adapter.remove('Old/n.md');
    expect(trashed).toEqual(['Old/n.md']);
  });

  it('prunes even when the file itself was already gone', async () => {
    const { app, trashed } = fakeApp([], []);
    (app.vault as { getAbstractFileByPath: (p: string) => unknown }).getAbstractFileByPath = (p) =>
      p === 'Empty' ? tfolder('Empty') : null;
    const adapter = new ObsidianVaultAdapter(app as never, () => []);
    await adapter.remove('Empty/x.md');
    expect(trashed).toEqual(['Empty']);
  });
});

describe('ObsidianVaultAdapter rename hints', () => {
  it('queues NFC-normalized renames in order and drains them once', async () => {
    const { app } = fakeApp([]);
    const adapter = new ObsidianVaultAdapter(app as never, () => []);
    adapter.noteRename('Ideas', 'Projects');
    adapter.noteRename('café.md', 'cafe.md'); // decomposed e + acute
    adapter.noteRename('same.md', 'same.md'); // dropped
    expect(await adapter.takeRenames()).toEqual([
      { from: 'Ideas', to: 'Projects' },
      { from: 'café.md', to: 'cafe.md' },
    ]);
    expect(await adapter.takeRenames()).toEqual([]);
  });
});
