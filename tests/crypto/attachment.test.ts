import { it, expect } from 'vitest';
import {
  encryptAttachment,
  decryptAttachmentMeta,
  decryptAttachmentBlob,
} from '../../src/crypto/attachment';

it('hides path/mime in meta, round-trips blob, carries plaintext hash', async () => {
  const master = new Uint8Array(32).fill(9);
  const bytes = new Uint8Array([1, 2, 3, 250, 251]);
  const { meta, blob } = await encryptAttachment(
    bytes,
    { path: 'img/Secret Chart.png', mimeType: 'image/png' },
    master
  );
  expect(JSON.stringify(meta)).not.toContain('Secret Chart');
  expect(blob).not.toEqual(bytes);
  const m = await decryptAttachmentMeta(meta, master);
  expect(m.path).toBe('img/Secret Chart.png');
  expect(m.mimeType).toBe('image/png');
  expect(m.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(await decryptAttachmentBlob(meta, blob, master)).toEqual(bytes);
});

it('fails loudly on tampered blob', async () => {
  const master = new Uint8Array(32).fill(9);
  const { meta, blob } = await encryptAttachment(
    new Uint8Array([7]),
    { path: 'a.png', mimeType: 'image/png' },
    master
  );
  blob[0] ^= 0xff;
  await expect(decryptAttachmentBlob(meta, blob, master)).rejects.toThrow();
});
