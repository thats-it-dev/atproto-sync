import { describe, it, expect } from 'vitest';
import {
  buildEncryptedAttachment,
  buildPlaintextAttachment,
  buildPlaintextNote,
  isEncrypted,
  ATTACHMENT_COLLECTION,
  NOTE_COLLECTION,
} from '../../src/lexicon/build';

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

describe('attachment builders', () => {
  const fakeBlobRef = { $type: 'blob', ref: { $link: 'bafyfake' }, mimeType: 'application/octet-stream', size: 5 };

  it('builds an encrypted attachment record hashing the meta ciphertext', async () => {
    const meta = {
      keyId: 'k', wrappedKey: 'w', keyNonce: 'kn', blobNonce: 'bn', metaNonce: 'mn', ciphertext: 'Y2lwaGVy',
    };
    const rec = await buildEncryptedAttachment({
      vault: 'v1', meta, blob: fakeBlobRef, updatedAt: '2026-08-17T00:00:00Z',
    });
    expect(rec.$type).toBe('app.notesky.attachment');
    expect(ATTACHMENT_COLLECTION).toBe('app.notesky.attachment');
    expect(rec.blob).toBe(fakeBlobRef);
    expect(rec.meta).toBe(meta);
    expect(rec.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('builds a plaintext attachment record with visible path and mime', async () => {
    const rec = await buildPlaintextAttachment({
      vault: 'v1', path: 'img/pic.png', mimeType: 'image/png',
      blob: fakeBlobRef, contentHash: 'a'.repeat(64), updatedAt: '2026-08-17T00:00:00Z',
    });
    expect(rec.meta).toEqual({ path: 'img/pic.png', mimeType: 'image/png' });
    expect(rec.contentHash).toBe('a'.repeat(64));
  });
});
