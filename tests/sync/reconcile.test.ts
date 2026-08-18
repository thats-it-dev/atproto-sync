import { describe, it, expect } from 'vitest';
import { reconcile, LocalFile, RemoteNote, IndexEntry } from '../../src/sync/reconcile';

const file = (path: string, content: string): LocalFile => ({ path, content });
const note = (rkey: string, cid: string, path: string, content: string, deleted = false): RemoteNote =>
  ({ rkey, cid, path, content, deleted });
const entry = (path: string, rkey: string, baseContent: string, lastCid: string): IndexEntry =>
  ({ path, rkey, baseContent, lastCid });

describe('reconcile: no-op, push, pull', () => {
  it('returns no ops when local, remote, and index all agree', () => {
    const ops = reconcile(
      [file('a.md', 'same')],
      [note('r1', 'cid-1', 'a.md', 'same')],
      [entry('a.md', 'r1', 'same', 'cid-1')]
    );
    expect(ops).toEqual([]);
  });

  it('pushes when local changed and remote is unchanged, CASing on the last cid', () => {
    const ops = reconcile(
      [file('a.md', 'edited locally')],
      [note('r1', 'cid-1', 'a.md', 'old')],
      [entry('a.md', 'r1', 'old', 'cid-1')]
    );
    expect(ops).toEqual([
      { kind: 'push', path: 'a.md', rkey: 'r1', content: 'edited locally', swapCid: 'cid-1' },
    ]);
  });

  it('pulls when remote changed and local is unchanged', () => {
    const ops = reconcile(
      [file('a.md', 'old')],
      [note('r1', 'cid-2', 'a.md', 'edited remotely')],
      [entry('a.md', 'r1', 'old', 'cid-1')]
    );
    expect(ops).toEqual([
      { kind: 'pull', path: 'a.md', rkey: 'r1', content: 'edited remotely', cid: 'cid-2' },
    ]);
  });
});

describe('reconcile: concurrent edits', () => {
  it('emits a single merge op carrying base, both sides, and the current remote cid', () => {
    const ops = reconcile(
      [file('a.md', 'local edit')],
      [note('r1', 'cid-9', 'a.md', 'remote edit')],
      [entry('a.md', 'r1', 'base text', 'cid-1')]
    );
    expect(ops).toEqual([
      {
        kind: 'merge',
        path: 'a.md',
        rkey: 'r1',
        base: 'base text',
        local: 'local edit',
        remote: 'remote edit',
        swapCid: 'cid-9',
      },
    ]);
  });
});

describe('reconcile: deletes with edit-wins semantics', () => {
  it('deletes remote when the local file is gone and remote is unchanged', () => {
    const ops = reconcile(
      [],
      [note('r1', 'cid-1', 'a.md', 'content')],
      [entry('a.md', 'r1', 'content', 'cid-1')]
    );
    expect(ops).toEqual([{ kind: 'deleteRemote', rkey: 'r1', path: 'a.md', swapCid: 'cid-1' }]);
  });

  it('deletes local when remote is tombstoned and local is unedited', () => {
    const ops = reconcile(
      [file('a.md', 'content')],
      [note('r1', 'cid-2', 'a.md', 'content', true)],
      [entry('a.md', 'r1', 'content', 'cid-1')]
    );
    expect(ops).toEqual([{ kind: 'deleteLocal', path: 'a.md', rkey: 'r1' }]);
  });

  it('resurrects the note via push when remote is tombstoned but local was edited', () => {
    const ops = reconcile(
      [file('a.md', 'edited after the delete')],
      [note('r1', 'cid-2', 'a.md', 'content', true)],
      [entry('a.md', 'r1', 'content', 'cid-1')]
    );
    expect(ops).toEqual([
      { kind: 'push', path: 'a.md', rkey: 'r1', content: 'edited after the delete', swapCid: 'cid-2' },
    ]);
  });

  it('pulls the remote edit when local deleted but remote changed', () => {
    const ops = reconcile(
      [],
      [note('r1', 'cid-2', 'a.md', 'remote edit')],
      [entry('a.md', 'r1', 'content', 'cid-1')]
    );
    expect(ops).toEqual([
      { kind: 'pull', path: 'a.md', rkey: 'r1', content: 'remote edit', cid: 'cid-2' },
    ]);
  });
});

describe('reconcile: duplicate remote records at one path', () => {
  it('keeps the lowest rkey and deletes the duplicate', () => {
    const ops = reconcile(
      [file('a.md', 'mine')],
      [note('r1', 'cid-1', 'a.md', 'mine'), note('r9', 'cid-9', 'a.md', 'theirs')],
      [entry('a.md', 'r1', 'mine', 'cid-1')]
    );
    expect(ops).toEqual([{ kind: 'deleteRemote', rkey: 'r9', path: 'a.md', swapCid: 'cid-9' }]);
  });

  it('drops index entries whose record vanished so the file re-merges with the survivor', () => {
    const ops = reconcile(
      [file('a.md', 'mine')],
      [note('r1', 'cid-1', 'a.md', 'theirs')],
      [entry('a.md', 'r9', 'mine', 'cid-9')] // r9 no longer exists remotely
    );
    expect(ops).toEqual([
      {
        kind: 'merge',
        path: 'a.md',
        rkey: 'r1',
        base: '',
        local: 'mine',
        remote: 'theirs',
        swapCid: 'cid-1',
      },
    ]);
  });
});

describe('reconcile: delete + replacement in one cycle', () => {
  it('pulls an unindexed remote into a path being vacated by deleteLocal', () => {
    const ops = reconcile(
      [file('a.md', 'content')],
      [
        note('r2', 'cid-2', 'a.md', 'replacement'),
        note('r1', 'cid-1', 'a.md', 'content', true), // tombstoned, local unedited
      ],
      [entry('a.md', 'r1', 'content', 'cid-1')]
    );
    expect(ops).toEqual([
      { kind: 'deleteLocal', path: 'a.md', rkey: 'r1' },
      { kind: 'pullCreate', path: 'a.md', rkey: 'r2', content: 'replacement', cid: 'cid-2' },
    ]);
  });
});

describe('reconcile: remote rename + replacement in one cycle', () => {
  it('pulls an unindexed remote into a path vacated by a remote rename', () => {
    const ops = reconcile(
      [file('old.png', 'HASH1')],
      [
        note('r1', 'cid-2', 'new.png', 'HASH1'), // renamed remotely, same content
        note('r2', 'cid-9', 'old.png', 'HASH2'), // new record at the old path
      ],
      [entry('old.png', 'r1', 'HASH1', 'cid-1')]
    );
    expect(ops).toEqual([
      { kind: 'pull', path: 'new.png', rkey: 'r1', content: 'HASH1', cid: 'cid-2' },
      { kind: 'pullCreate', path: 'old.png', rkey: 'r2', content: 'HASH2', cid: 'cid-9' },
    ]);
  });
});

describe('reconcile: identical content needs no merge (re-scan case)', () => {
  it('adopts a same-path create when local and remote content are identical', () => {
    const ops = reconcile(
      [file('img.png', 'HASH1:enc')],
      [note('r1', 'cid-1', 'img.png', 'HASH1:enc')],
      [] // empty index: exactly the state after a full re-scan
    );
    expect(ops).toEqual([
      { kind: 'adopt', path: 'img.png', rkey: 'r1', content: 'HASH1:enc', cid: 'cid-1' },
    ]);
  });

  it('adopts when both sides changed to the same content', () => {
    const ops = reconcile(
      [file('a.md', 'same edit')],
      [note('r1', 'cid-2', 'a.md', 'same edit')],
      [entry('a.md', 'r1', 'old base', 'cid-1')]
    );
    expect(ops).toEqual([
      { kind: 'adopt', path: 'a.md', rkey: 'r1', content: 'same edit', cid: 'cid-2' },
    ]);
  });
});

describe('reconcile: creates', () => {
  it('pushCreates a local file with no index entry and no remote at that path', () => {
    const ops = reconcile([file('new.md', 'brand new')], [], []);
    expect(ops).toEqual([{ kind: 'pushCreate', path: 'new.md', content: 'brand new' }]);
  });

  it('pullCreates a remote record with no index entry and no local file', () => {
    const ops = reconcile([], [note('r9', 'cid-5', 'incoming.md', 'from remote')], []);
    expect(ops).toEqual([
      { kind: 'pullCreate', path: 'incoming.md', rkey: 'r9', content: 'from remote', cid: 'cid-5' },
    ]);
  });

  it('same-path simultaneous create resolves to a merge with an empty base', () => {
    const ops = reconcile(
      [file('both.md', 'local version')],
      [note('r2', 'cid-3', 'both.md', 'remote version')],
      []
    );
    expect(ops).toEqual([
      {
        kind: 'merge',
        path: 'both.md',
        rkey: 'r2',
        base: '',
        local: 'local version',
        remote: 'remote version',
        swapCid: 'cid-3',
      },
    ]);
  });
});
