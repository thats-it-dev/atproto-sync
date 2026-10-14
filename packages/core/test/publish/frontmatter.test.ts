import { describe, it, expect } from 'vitest';
import {
  isPublicNote,
  getPublicSlug,
  setPublicFlag,
  removePublicFlag,
  extractEmbedTargets,
} from '../../src/publish/frontmatter';

describe('public flag frontmatter', () => {
  it('adds the flag to a note without frontmatter', () => {
    const out = setPublicFlag('# Hello\n\nBody\n');
    expect(out).toBe('---\nnotesky_public: true\n---\n\n# Hello\n\nBody\n');
    expect(isPublicNote(out)).toBe(true);
  });

  it('adds the flag and slug to existing frontmatter, preserving other keys', () => {
    const out = setPublicFlag('---\ntags: [a, b]\n---\n\nBody\n', 'my-note');
    expect(out).toBe('---\ntags: [a, b]\nnotesky_public: true\nnotesky_slug: my-note\n---\n\nBody\n');
    expect(isPublicNote(out)).toBe(true);
    expect(getPublicSlug(out)).toBe('my-note');
  });

  it('is idempotent', () => {
    const once = setPublicFlag('Body\n', 'slug-1');
    expect(setPublicFlag(once, 'slug-1')).toBe(once);
  });

  it('updates the slug when set again with a different slug', () => {
    const out = setPublicFlag(setPublicFlag('Body\n', 'old'), 'new');
    expect(getPublicSlug(out)).toBe('new');
  });

  it('removes the flag and slug, dropping an emptied frontmatter block', () => {
    expect(removePublicFlag(setPublicFlag('# Hello\n\nBody\n'))).toBe('# Hello\n\nBody\n');
    const withTags = setPublicFlag('---\ntags: [a]\n---\n\nBody\n', 's');
    expect(removePublicFlag(withTags)).toBe('---\ntags: [a]\n---\n\nBody\n');
  });

  it('is not fooled by frontmatter-less notes mentioning the key', () => {
    expect(isPublicNote('notesky_public: true\n')).toBe(false);
  });
});

describe('extractEmbedTargets', () => {
  it('finds wiki embeds and markdown image embeds, ignoring plain links', () => {
    const md = [
      '![[diagram.png]]',
      '![[Files/report.pdf|the report]]',
      '![alt text](assets/photo.jpg)',
      '[[just a link]]',
      '[not an embed](x.png)',
      '![external](https://example.com/a.png)',
    ].join('\n');
    expect(extractEmbedTargets(md)).toEqual([
      'diagram.png',
      'Files/report.pdf',
      'assets/photo.jpg',
    ]);
  });
});
