import { describe, it, expect } from 'vitest';
import { FakePds } from '../../src/sync/fake-pds';
import { ATTACHMENT_COLLECTION, NOTE_COLLECTION, TOMBSTONE_COLLECTION } from '../../src/lexicon/build';
import { makeEngine } from './helpers';

const MASTER = new Uint8Array(32).fill(5);

const rkeys = async (pds: FakePds, collection = NOTE_COLLECTION) =>
  (await pds.listRecords(collection)).map((r) => r.rkey).sort();

describe('rename scenarios (adapter-reported moves)', () => {
  it('folder rename with an unsynced edit inside keeps every record and leaves no old files', async () => {
    const pds = new FakePds();
    const a = makeEngine(pds, MASTER);
    const b = makeEngine(pds, MASTER);
    await a.vault.write('Ideas/plain.md', 'plain\n');
    await a.vault.write('Ideas/edited.md', 'v1\n');
    await a.vault.writeBinary('Ideas/img.png', new Uint8Array([1, 2, 3]));
    await a.engine.sync();
    await b.engine.sync();
    const noteRkeys = await rkeys(pds);
    const attRkeys = await rkeys(pds, ATTACHMENT_COLLECTION);

    // Edit first (not yet synced), then rename the whole folder.
    await a.vault.write('Ideas/edited.md', 'v2\n');
    await a.vault.rename('Ideas', 'Projects');
    await a.engine.sync();
    await b.engine.sync();

    expect(await rkeys(pds)).toEqual(noteRkeys);
    expect(await rkeys(pds, ATTACHMENT_COLLECTION)).toEqual(attRkeys);
    expect((await pds.listRecords(TOMBSTONE_COLLECTION)).length).toBe(0);
    for (const d of [a, b]) {
      expect([...d.vault.files.keys()].sort()).toEqual(['Projects/edited.md', 'Projects/plain.md']);
      expect([...d.vault.binaries.keys()]).toEqual(['Projects/img.png']);
      expect(await d.vault.read('Projects/edited.md')).toBe('v2\n');
    }
  });

  it('rename on A while B edits the same note: B\'s edit lands in A\'s new name everywhere', async () => {
    const pds = new FakePds();
    const a = makeEngine(pds, MASTER);
    const b = makeEngine(pds, MASTER);
    await a.vault.write('n.md', 'base\n');
    await a.engine.sync();
    await b.engine.sync();
    const [rkey] = await rkeys(pds);

    await b.vault.write('n.md', 'B edit\n');
    await b.engine.sync();
    await a.vault.rename('n.md', 'm.md');
    await a.engine.sync();
    await b.engine.sync();

    expect(await rkeys(pds)).toEqual([rkey]);
    for (const d of [a, b]) {
      expect([...d.vault.files.keys()]).toEqual(['m.md']);
      expect(await d.vault.read('m.md')).toBe('B edit\n');
    }
  });

  it('remote rename + local edit: the merge moves the local file to the new name', async () => {
    const pds = new FakePds();
    const a = makeEngine(pds, MASTER);
    const b = makeEngine(pds, MASTER);
    await a.vault.write('n.md', 'line1\nline2\n');
    await a.engine.sync();
    await b.engine.sync();

    await a.vault.rename('n.md', 'Archive/n.md');
    await a.vault.write('Archive/n.md', 'line1 A\nline2\n');
    await a.engine.sync();
    await b.vault.write('n.md', 'line1\nline2 B\n');
    await b.engine.sync();
    await a.engine.sync();

    for (const d of [a, b]) {
      expect([...d.vault.files.keys()]).toEqual(['Archive/n.md']);
      expect(await d.vault.read('Archive/n.md')).toBe('line1 A\nline2 B\n');
    }
    expect((await pds.listRecords(NOTE_COLLECTION)).length).toBe(1);
  });

  it('both devices rename the same file differently: they converge on one name', async () => {
    const pds = new FakePds();
    const a = makeEngine(pds, MASTER);
    const b = makeEngine(pds, MASTER);
    await a.vault.write('n.md', 'same\n');
    await a.engine.sync();
    await b.engine.sync();

    await a.vault.rename('n.md', 'x.md');
    await b.vault.rename('n.md', 'y.md');
    await a.engine.sync();
    await b.engine.sync(); // B's local name wins the race
    await a.engine.sync();

    expect([...a.vault.files.keys()]).toEqual(['y.md']);
    expect([...b.vault.files.keys()]).toEqual(['y.md']);
    expect((await pds.listRecords(NOTE_COLLECTION)).length).toBe(1);
  });

  it('renaming and renaming back before a sync pushes nothing', async () => {
    const pds = new FakePds();
    const a = makeEngine(pds, MASTER);
    await a.vault.write('n.md', 'same\n');
    await a.engine.sync();
    const before = await pds.listRecords(NOTE_COLLECTION);

    await a.vault.rename('n.md', 'tmp.md');
    await a.vault.rename('tmp.md', 'n.md');
    await a.engine.sync();

    expect(await pds.listRecords(NOTE_COLLECTION)).toEqual(before);
    expect(a.index.entries.map((e) => e.remotePath)).toEqual([undefined]);
  });

  it('a binary moved locally while replaced remotely takes the remote bytes at the new path', async () => {
    const pds = new FakePds();
    const a = makeEngine(pds, MASTER);
    const b = makeEngine(pds, MASTER);
    await a.vault.writeBinary('img.png', new Uint8Array([1]));
    await a.engine.sync();
    await b.engine.sync();

    await b.vault.writeBinary('img.png', new Uint8Array([2, 2]));
    await b.engine.sync();
    await a.vault.rename('img.png', 'pics/img.png');
    await a.engine.sync();
    await b.engine.sync();

    for (const d of [a, b]) {
      expect([...d.vault.binaries.keys()]).toEqual(['pics/img.png']);
      expect([...(await d.vault.readBinary('pics/img.png'))]).toEqual([2, 2]);
    }
    expect((await pds.listRecords(ATTACHMENT_COLLECTION)).length).toBe(1);
  });

  it('index entries carry no remotePath once a rename has been pushed', async () => {
    const pds = new FakePds();
    const a = makeEngine(pds, MASTER);
    await a.vault.write('n.md', 'same\n');
    await a.engine.sync();
    await a.vault.rename('n.md', 'm.md');
    await a.engine.sync();
    expect(a.index.entries).toHaveLength(1);
    expect(a.index.entries[0].path).toBe('m.md');
    expect(a.index.entries[0].remotePath).toBeUndefined();
  });
});
