import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FakePds } from '@atproto-sync/core/sync/fake-pds';
import { SyncEngine } from '@atproto-sync/core/sync/engine';
import { NOTE_COLLECTION } from '@atproto-sync/core/lexicon/build';
import { FsVaultAdapter } from '../src/fs-vault';
import { FsIndexStore } from '../src/fs-store';

const IGNORES = ['.obsidian/', '.atpsync/', '.git/'];

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'atpsync-pi-renames-'));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function mkvault(name: string): Promise<string> {
  return fs.mkdtemp(path.join(tmp, `${name}-`));
}

function adapter(dir: string): FsVaultAdapter {
  return new FsVaultAdapter(dir, () => IGNORES, path.join(dir, '.atpsync', 'inodes.json'));
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false
  );

describe('FsVaultAdapter.takeRenames (inode tracking)', () => {
  it('reports nothing on the first pass and persists its state', async () => {
    const dir = await mkvault('first');
    await fs.writeFile(path.join(dir, 'a.md'), 'a');
    const v = adapter(dir);
    expect(await v.takeRenames()).toEqual([]);
    expect(await exists(path.join(dir, '.atpsync', 'inodes.json'))).toBe(true);
  });

  it('detects a file rename, even after the moved file was edited', async () => {
    const dir = await mkvault('file');
    await fs.writeFile(path.join(dir, 'a.md'), 'a');
    const v = adapter(dir);
    await v.takeRenames();

    await fs.rename(path.join(dir, 'a.md'), path.join(dir, 'b.md'));
    await fs.appendFile(path.join(dir, 'b.md'), ' edited');
    expect(await v.takeRenames()).toEqual([{ from: 'a.md', to: 'b.md' }]);
    expect(await v.takeRenames()).toEqual([]); // consumed
  });

  it('detects a folder rename as one hint per file beneath it', async () => {
    const dir = await mkvault('folder');
    await fs.mkdir(path.join(dir, 'Ideas', 'sub'), { recursive: true });
    await fs.writeFile(path.join(dir, 'Ideas', 'a.md'), 'a');
    await fs.writeFile(path.join(dir, 'Ideas', 'sub', 'pic.png'), 'png');
    const v = adapter(dir);
    await v.takeRenames();

    await fs.rename(path.join(dir, 'Ideas'), path.join(dir, 'Projects'));
    const hints = await v.takeRenames();
    expect(hints.sort((x, y) => x.from.localeCompare(y.from))).toEqual([
      { from: 'Ideas/a.md', to: 'Projects/a.md' },
      { from: 'Ideas/sub/pic.png', to: 'Projects/sub/pic.png' },
    ]);
  });

  it('detects a file moved from one folder to another', async () => {
    const dir = await mkvault('move');
    await fs.mkdir(path.join(dir, 'Inbox'));
    await fs.mkdir(path.join(dir, 'Archive'));
    await fs.writeFile(path.join(dir, 'Inbox', 'note.md'), 'n');
    const v = adapter(dir);
    await v.takeRenames();

    await fs.rename(path.join(dir, 'Inbox', 'note.md'), path.join(dir, 'Archive', 'note.md'));
    expect(await v.takeRenames()).toEqual([{ from: 'Inbox/note.md', to: 'Archive/note.md' }]);
  });

  it('ignores plain creates, deletes, in-place edits and ignored paths', async () => {
    const dir = await mkvault('noise');
    await fs.writeFile(path.join(dir, 'keep.md'), 'k');
    await fs.writeFile(path.join(dir, 'gone.md'), 'g');
    const v = adapter(dir);
    await v.takeRenames();

    await fs.rm(path.join(dir, 'gone.md'));
    await fs.writeFile(path.join(dir, 'new.md'), 'n');
    await fs.writeFile(path.join(dir, 'keep.md'), 'k2');
    await fs.mkdir(path.join(dir, '.obsidian'));
    await fs.writeFile(path.join(dir, '.obsidian', 'x.json'), '{}');
    expect(await v.takeRenames()).toEqual([]);
  });

  it('survives process restarts: a rename made between two adapter instances is still seen', async () => {
    const dir = await mkvault('restart');
    await fs.writeFile(path.join(dir, 'a.md'), 'a');
    await adapter(dir).takeRenames();

    await fs.rename(path.join(dir, 'a.md'), path.join(dir, 'moved.md'));
    expect(await adapter(dir).takeRenames()).toEqual([{ from: 'a.md', to: 'moved.md' }]);
  });
});

describe('FsVaultAdapter.remove prunes empty directories', () => {
  it('removes emptied parents up to, but not including, the vault root', async () => {
    const dir = await mkvault('prune');
    await fs.mkdir(path.join(dir, 'a', 'b', 'c'), { recursive: true });
    await fs.writeFile(path.join(dir, 'a', 'b', 'c', 'x.md'), 'x');
    await fs.writeFile(path.join(dir, 'a', 'other.md'), 'o');
    const v = adapter(dir);

    await v.remove('a/b/c/x.md');
    expect(await exists(path.join(dir, 'a', 'b'))).toBe(false);
    expect(await exists(path.join(dir, 'a', 'other.md'))).toBe(true);

    await v.remove('a/other.md');
    expect(await exists(path.join(dir, 'a'))).toBe(false);
    expect(await exists(dir)).toBe(true);
  });

  it('is a no-op for a missing file', async () => {
    const dir = await mkvault('missing');
    await expect(adapter(dir).remove('nope/x.md')).resolves.toBeUndefined();
  });
});

describe('two filesystem devices', () => {
  function engine(pds: FakePds, dir: string, master: Uint8Array): SyncEngine {
    return new SyncEngine({
      pds,
      vault: adapter(dir),
      index: new FsIndexStore(path.join(dir, '.atpsync', 'index.json')),
      masterKey: master,
      vaultRkey: 'test-vault',
    });
  }

  it('a folder rename with an edit inside moves the folder on the other device, old folder gone', async () => {
    const pds = new FakePds();
    const master = new Uint8Array(32).fill(9);
    const dirA = await mkvault('A');
    const dirB = await mkvault('B');
    const a = engine(pds, dirA, master);
    const b = engine(pds, dirB, master);

    await fs.mkdir(path.join(dirA, 'Ideas'));
    await fs.writeFile(path.join(dirA, 'Ideas', 'one.md'), 'one');
    await fs.writeFile(path.join(dirA, 'Ideas', 'two.md'), 'two');
    await fs.writeFile(path.join(dirA, 'Ideas', 'pic.png'), 'png');
    await a.sync();
    await b.sync();
    const before = (await pds.listRecords(NOTE_COLLECTION)).map((r) => r.rkey).sort();

    await fs.writeFile(path.join(dirA, 'Ideas', 'two.md'), 'two edited');
    await fs.rename(path.join(dirA, 'Ideas'), path.join(dirA, 'Projects'));
    await a.sync();
    await b.sync();

    expect((await pds.listRecords(NOTE_COLLECTION)).map((r) => r.rkey).sort()).toEqual(before);
    for (const dir of [dirA, dirB]) {
      expect(await exists(path.join(dir, 'Ideas'))).toBe(false);
      expect((await fs.readdir(path.join(dir, 'Projects'))).sort()).toEqual(['one.md', 'pic.png', 'two.md']);
      expect(await fs.readFile(path.join(dir, 'Projects', 'two.md'), 'utf8')).toBe('two edited');
    }
  });

  it('moving a file between folders on one device moves it on the other and drops the emptied folder', async () => {
    const pds = new FakePds();
    const master = new Uint8Array(32).fill(6);
    const dirA = await mkvault('mvA');
    const dirB = await mkvault('mvB');
    const a = engine(pds, dirA, master);
    const b = engine(pds, dirB, master);

    await fs.mkdir(path.join(dirA, 'Inbox'));
    await fs.writeFile(path.join(dirA, 'Inbox', 'note.md'), 'draft');
    await a.sync();
    await b.sync();
    const [rkey] = (await pds.listRecords(NOTE_COLLECTION)).map((r) => r.rkey);

    await fs.mkdir(path.join(dirA, 'Archive'));
    await fs.rename(path.join(dirA, 'Inbox', 'note.md'), path.join(dirA, 'Archive', 'note.md'));
    await fs.appendFile(path.join(dirA, 'Archive', 'note.md'), ' done');
    await a.sync();
    await b.sync();

    expect((await pds.listRecords(NOTE_COLLECTION)).map((r) => r.rkey)).toEqual([rkey]);
    expect(await fs.readFile(path.join(dirB, 'Archive', 'note.md'), 'utf8')).toBe('draft done');
    expect(await exists(path.join(dirB, 'Inbox'))).toBe(false);
  });

  it('deleting a folder on one device removes it entirely on the other', async () => {
    const pds = new FakePds();
    const master = new Uint8Array(32).fill(4);
    const dirA = await mkvault('delA');
    const dirB = await mkvault('delB');
    const a = engine(pds, dirA, master);
    const b = engine(pds, dirB, master);

    await fs.mkdir(path.join(dirA, 'Old', 'deep'), { recursive: true });
    await fs.writeFile(path.join(dirA, 'Old', 'deep', 'n.md'), 'n');
    await fs.writeFile(path.join(dirA, 'Old', 'p.png'), 'p');
    await a.sync();
    await b.sync();
    expect(await exists(path.join(dirB, 'Old', 'deep', 'n.md'))).toBe(true);

    await fs.rm(path.join(dirA, 'Old'), { recursive: true });
    await a.sync();
    await b.sync();
    expect(await exists(path.join(dirB, 'Old'))).toBe(false);
    expect((await pds.listRecords(NOTE_COLLECTION)).length).toBe(0);
  });
});
