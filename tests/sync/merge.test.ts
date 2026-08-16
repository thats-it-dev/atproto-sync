import { describe, it, expect } from 'vitest';
import { merge3 } from '../../src/sync/merge';

describe('merge3', () => {
  it('merges non-overlapping edits cleanly', () => {
    const base = 'line1\nline2\nline3\n';
    const local = 'line1 edited\nline2\nline3\n';
    const remote = 'line1\nline2\nline3 edited\n';
    const r = merge3(base, local, remote);
    expect(r.clean).toBe(true);
    expect(r.merged).toBe('line1 edited\nline2\nline3 edited\n');
  });
  it('flags overlapping edits as conflict and includes both sides', () => {
    const r = merge3('a\n', 'local a\n', 'remote a\n');
    expect(r.clean).toBe(false);
    expect(r.merged).toContain('local a');
    expect(r.merged).toContain('remote a');
  });
});
