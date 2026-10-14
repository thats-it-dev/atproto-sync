import { describe, it, expect } from 'vitest';
import { merge3 } from '../../src/sync/merge';

describe('merge3 (character-level)', () => {
  it('merges non-overlapping line edits cleanly', () => {
    const base = 'line1\nline2\nline3\n';
    const local = 'line1 edited\nline2\nline3\n';
    const remote = 'line1\nline2\nline3 edited\n';
    const r = merge3(base, local, remote);
    expect(r.clean).toBe(true);
    expect(r.merged).toBe('line1 edited\nline2\nline3 edited\n');
  });

  it('merges compatible edits to the SAME line — the case line merging cannot handle', () => {
    const base = 'The quick brown fox jumps over the lazy dog.\n';
    const local = 'The very quick brown fox jumps over the lazy dog.\n'; // edit at start
    const remote = 'The quick brown fox jumps over the sleepy dog.\n'; // edit at end
    const r = merge3(base, local, remote);
    expect(r.clean).toBe(true);
    expect(r.merged).toBe('The very quick brown fox jumps over the sleepy dog.\n');
  });

  it('returns remote-favored text and clean=false when a patch cannot apply', () => {
    const base = 'alpha beta gamma delta\n';
    const local = 'alpha beta GAMMA delta\n'; // small local edit...
    const remote = 'completely rewritten text that shares nothing at all\n'; // ...context gone
    const r = merge3(base, local, remote);
    expect(r.clean).toBe(false);
    expect(r.merged).toBe(remote); // remote stands where the patch failed
  });

  it('handles identity cases', () => {
    expect(merge3('a\n', 'a\n', 'b\n')).toEqual({ clean: true, merged: 'b\n' }); // local unchanged
    expect(merge3('a\n', 'b\n', 'a\n')).toEqual({ clean: true, merged: 'b\n' }); // remote unchanged
    expect(merge3('a\n', 'b\n', 'b\n')).toEqual({ clean: true, merged: 'b\n' }); // same edit twice
  });
});
