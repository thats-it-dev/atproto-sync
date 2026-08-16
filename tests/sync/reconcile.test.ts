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
