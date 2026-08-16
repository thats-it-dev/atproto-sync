import { it, expect } from 'vitest';
import { encryptNote, decryptNote } from '../../src/crypto/note';

it('hides path and title inside the ciphertext and round-trips', async () => {
  const master = new Uint8Array(32).fill(9);
  const enc = await encryptNote({ path: 'Private/Journal.md', title: 'Journal', body: 'dear diary' }, master);
  const json = JSON.stringify(enc);
  expect(json).not.toContain('Journal');
  expect(json).not.toContain('dear diary');
  const dec = await decryptNote(enc, master);
  expect(dec).toEqual({ path: 'Private/Journal.md', title: 'Journal', body: 'dear diary' });
});
