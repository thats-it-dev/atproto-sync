import { describe, it, expect } from 'vitest';
import { buildPlaintextNote, isEncrypted, NOTE_COLLECTION } from '../../src/lexicon/build';

describe('lexicon builders', () => {
  it('builds a plaintext note record with slug derived from title', async () => {
    const rec = await buildPlaintextNote({
      vault: 'vault123', path: 'Ideas/My Great Note.md',
      text: '# hi', createdAt: '2026-08-16T00:00:00Z', updatedAt: '2026-08-16T00:00:00Z',
    });
    expect(rec.$type).toBe('app.notesky.note');
    expect(NOTE_COLLECTION).toBe('app.notesky.note');
    if (isEncrypted(rec.content)) throw new Error('expected plaintext');
    expect(rec.content.title).toBe('My Great Note');
    expect(rec.content.slug).toBe('my-great-note');
    expect(rec.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
