import { describe, it, expect } from 'vitest';
import { mimeFromPath, resolvePublicAttachments } from '../../src/publish/cascade';

const pub = (path: string, body: string) => ({
  path,
  content: `---\nnotesky_public: true\n---\n\n${body}\n`,
});
const priv = (path: string, body: string) => ({ path, content: body });

describe('resolvePublicAttachments', () => {
  it('collects embeds from public notes only', () => {
    const set = resolvePublicAttachments(
      [pub('a.md', '![[img/chart.png]]'), priv('b.md', '![[secret.png]]')],
      ['img/chart.png', 'secret.png']
    );
    expect(set).toEqual(new Set(['img/chart.png']));
  });

  it('exact path match wins; unique basename matches resolve; ambiguous are skipped', () => {
    const set = resolvePublicAttachments(
      [pub('a.md', '![[chart.png]] ![[dup.png]] ![[assets/exact.png]]')],
      ['img/chart.png', 'one/dup.png', 'two/dup.png', 'assets/exact.png']
    );
    expect(set).toEqual(new Set(['img/chart.png', 'assets/exact.png']));
  });

  it('handles markdown-style image embeds', () => {
    const set = resolvePublicAttachments(
      [pub('a.md', '![alt](img/photo.jpg)')],
      ['img/photo.jpg']
    );
    expect(set).toEqual(new Set(['img/photo.jpg']));
  });
});

describe('mimeFromPath', () => {
  it('maps common extensions and defaults to octet-stream', () => {
    expect(mimeFromPath('a/b.PNG')).toBe('image/png');
    expect(mimeFromPath('x.jpeg')).toBe('image/jpeg');
    expect(mimeFromPath('doc.pdf')).toBe('application/pdf');
    expect(mimeFromPath('weird.xyz')).toBe('application/octet-stream');
  });
});
