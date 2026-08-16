import { describe, it, expect } from 'vitest';
import { isIgnored } from '../../src/obsidian/ignore';

describe('isIgnored', () => {
  it('matches exact paths and folder prefixes', () => {
    expect(isIgnored('secrets.md', ['secrets.md'])).toBe(true);
    expect(isIgnored('Private/a.md', ['Private'])).toBe(true);
    expect(isIgnored('Private/deep/b.md', ['Private/'])).toBe(true);
    expect(isIgnored('PrivateStuff/a.md', ['Private'])).toBe(false);
    expect(isIgnored('notes/a.md', ['Private'])).toBe(false);
  });

  it('supports * and ** globs', () => {
    expect(isIgnored('drafts/wip.md', ['drafts/*.md'])).toBe(true);
    expect(isIgnored('drafts/sub/wip.md', ['drafts/*.md'])).toBe(false);
    expect(isIgnored('drafts/sub/wip.md', ['drafts/**'])).toBe(true);
    expect(isIgnored('a/tmp-1.md', ['**/tmp-*.md'])).toBe(true);
  });

  it('ignores blank patterns', () => {
    expect(isIgnored('a.md', ['', '  '])).toBe(false);
  });
});
