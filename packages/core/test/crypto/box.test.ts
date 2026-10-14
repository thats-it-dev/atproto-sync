import { describe, it, expect } from 'vitest';
import { generateNoteKey, wrapKey, unwrapKey, encrypt, decrypt } from '../../src/crypto/box';

describe('note key lifecycle', () => {
  it('round-trips: wrap key, unwrap key, encrypt content, decrypt content', async () => {
    const master = new Uint8Array(32).fill(7);
    const noteKey = await generateNoteKey();
    const wrapped = await wrapKey(noteKey, master);
    expect(await unwrapKey(wrapped, master)).toEqual(noteKey);
    const box = await encrypt(new TextEncoder().encode('secret note'), noteKey);
    expect(new TextDecoder().decode(await decrypt(box, noteKey))).toBe('secret note');
  });
  it('fails loudly on wrong key and on tampered ciphertext', async () => {
    const noteKey = await generateNoteKey();
    const box = await encrypt(new TextEncoder().encode('x'), noteKey);
    await expect(decrypt(box, await generateNoteKey())).rejects.toThrow();
    box.ciphertext[0] ^= 0xff;
    await expect(decrypt(box, noteKey)).rejects.toThrow();
  });
});
