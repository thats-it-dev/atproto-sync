import { describe, it, expect } from 'vitest';
import {
  applyRenames,
  reconcile,
  LocalFile,
  RemoteNote,
  IndexEntry,
} from '../../src/sync/reconcile';

const file = (path: string, content: string): LocalFile => ({ path, content });
const note = (rkey: string, cid: string, path: string, content: string, deleted = false): RemoteNote =>
  ({ rkey, cid, path, content, deleted });
const entry = (
  path: string,
  rkey: string,
  baseContent: string,
  lastCid: string,
  remotePath?: string
): IndexEntry => (remotePath ? { path, rkey, baseContent, lastCid, remotePath } : { path, rkey, baseContent, lastCid });

describe('applyRenames', () => {
  it('rewrites a file entry and remembers where the record still lives', () => {
    const out = applyRenames([entry('a.md', 'r1', 'x', 'c1')], [{ from: 'a.md', to: 'b.md' }]);
    expect(out).toEqual([entry('b.md', 'r1', 'x', 'c1', 'a.md')]);
  });

  it('rewrites everything beneath a renamed folder, leaving look-alike paths alone', () => {
    const out = applyRenames(
      [
        entry('Ideas/a.md', 'r1', 'x', 'c1'),
        entry('Ideas/sub/b.png', 'r2', 'h', 'c2'),
        entry('Ideas2/c.md', 'r3', 'y', 'c3'),
      ],
      [{ from: 'Ideas', to: 'Projects' }]
    );
    expect(out).toEqual([
      entry('Projects/a.md', 'r1', 'x', 'c1', 'Ideas/a.md'),
      entry('Projects/sub/b.png', 'r2', 'h', 'c2', 'Ideas/sub/b.png'),
      entry('Ideas2/c.md', 'r3', 'y', 'c3'),
    ]);
  });

  it('applies chained renames in order and keeps the original remote path', () => {
    const out = applyRenames(
      [entry('a.md', 'r1', 'x', 'c1'), entry('c.md', 'r2', 'y', 'c2')],
      [
        { from: 'a.md', to: 'b.md' },
        { from: 'c.md', to: 'a.md' },
      ]
    );
    expect(out).toEqual([
      entry('b.md', 'r1', 'x', 'c1', 'a.md'),
      entry('a.md', 'r2', 'y', 'c2', 'c.md'),
    ]);
  });

  it('renaming back before a sync leaves the entry untouched', () => {
    const out = applyRenames(
      [entry('a.md', 'r1', 'x', 'c1')],
      [
        { from: 'a.md', to: 'b.md' },
        { from: 'b.md', to: 'a.md' },
      ]
    );
    expect(out).toEqual([entry('a.md', 'r1', 'x', 'c1')]);
  });

  it('does not mutate its input', () => {
    const input = [entry('a.md', 'r1', 'x', 'c1')];
    applyRenames(input, [{ from: 'a.md', to: 'b.md' }]);
    expect(input).toEqual([entry('a.md', 'r1', 'x', 'c1')]);
  });
});

describe('reconcile: local renames via index hints', () => {
  it('pushes the new path onto the same rkey when nothing else changed', () => {
    const ops = reconcile(
      [file('new.md', 'same')],
      [note('r1', 'c1', 'old.md', 'same')],
      [entry('new.md', 'r1', 'same', 'c1', 'old.md')]
    );
    expect(ops).toEqual([{ kind: 'push', path: 'new.md', rkey: 'r1', content: 'same', swapCid: 'c1' }]);
  });

  it('pushes a rename together with a local edit, never delete + create', () => {
    const ops = reconcile(
      [file('new.md', 'edited')],
      [note('r1', 'c1', 'old.md', 'same')],
      [entry('new.md', 'r1', 'same', 'c1', 'old.md')]
    );
    expect(ops).toEqual([{ kind: 'push', path: 'new.md', rkey: 'r1', content: 'edited', swapCid: 'c1' }]);
  });

  it('local move + remote edit: pulls the edit into the moved file, then pushes the path', () => {
    const ops = reconcile(
      [file('new.md', 'same')],
      [note('r1', 'c2', 'old.md', 'remote edit')],
      [entry('new.md', 'r1', 'same', 'c1', 'old.md')]
    );
    expect(ops).toEqual([
      { kind: 'pull', path: 'new.md', rkey: 'r1', content: 'remote edit', cid: 'c2' },
      { kind: 'push', path: 'new.md', rkey: 'r1', content: 'remote edit', swapCid: 'c2' },
    ]);
  });

  it('both sides moved, content untouched: the local path wins with one push', () => {
    const ops = reconcile(
      [file('mine.md', 'same')],
      [note('r1', 'c2', 'theirs.md', 'same')],
      [entry('mine.md', 'r1', 'same', 'c1', 'old.md')]
    );
    expect(ops).toEqual([{ kind: 'push', path: 'mine.md', rkey: 'r1', content: 'same', swapCid: 'c2' }]);
  });

  it('local move + local edit + remote edit: merges at the local path', () => {
    const ops = reconcile(
      [file('new.md', 'local edit')],
      [note('r1', 'c2', 'old.md', 'remote edit')],
      [entry('new.md', 'r1', 'base', 'c1', 'old.md')]
    );
    expect(ops).toEqual([
      {
        kind: 'merge',
        path: 'new.md',
        localPath: 'new.md',
        rkey: 'r1',
        base: 'base',
        local: 'local edit',
        remote: 'remote edit',
        swapCid: 'c2',
      },
    ]);
  });

  it('a moved file that the remote deleted is deleted locally (delete beats a bare move)', () => {
    const ops = reconcile(
      [file('new.md', 'same')],
      [note('r1', 'tomb', 'old.md', 'same', true)],
      [entry('new.md', 'r1', 'same', 'c1', 'old.md')]
    );
    expect(ops).toEqual([{ kind: 'deleteLocal', path: 'new.md', rkey: 'r1' }]);
  });

  it('a moved file whose new path is no longer visible locally is a remote delete', () => {
    // e.g. moved into an ignored folder
    const ops = reconcile(
      [],
      [note('r1', 'c1', 'old.md', 'same')],
      [entry('ignored/new.md', 'r1', 'same', 'c1', 'old.md')]
    );
    expect(ops).toEqual([{ kind: 'deleteRemote', rkey: 'r1', path: 'ignored/new.md', swapCid: 'c1' }]);
  });
});

describe('reconcile: remote renames', () => {
  it('remote move + local edit: merges at the remote path and vacates the local one', () => {
    const ops = reconcile(
      [file('old.md', 'local edit')],
      [note('r1', 'c2', 'new.md', 'remote edit')],
      [entry('old.md', 'r1', 'base', 'c1')]
    );
    expect(ops).toEqual([
      {
        kind: 'merge',
        path: 'new.md',
        localPath: 'old.md',
        rkey: 'r1',
        base: 'base',
        local: 'local edit',
        remote: 'remote edit',
        swapCid: 'c2',
      },
    ]);
  });

  it('remote move + identical local edit: pulls to the new path instead of adopting in place', () => {
    const ops = reconcile(
      [file('old.md', 'same edit')],
      [note('r1', 'c2', 'new.md', 'same edit')],
      [entry('old.md', 'r1', 'base', 'c1')]
    );
    expect(ops).toEqual([{ kind: 'pull', path: 'new.md', rkey: 'r1', content: 'same edit', cid: 'c2' }]);
  });

  it('a merge that vacates a path lets an unindexed remote move in behind it', () => {
    const ops = reconcile(
      [file('old.md', 'local edit')],
      [note('r1', 'c2', 'new.md', 'remote edit'), note('r2', 'c9', 'old.md', 'newcomer')],
      [entry('old.md', 'r1', 'base', 'c1')]
    );
    expect(ops.map((o) => o.kind)).toEqual(['merge', 'pullCreate']);
    expect(ops[1]).toMatchObject({ path: 'old.md', rkey: 'r2' });
  });
});
