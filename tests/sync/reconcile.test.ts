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
