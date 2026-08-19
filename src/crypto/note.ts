import sodium from 'libsodium-wrappers-sumo';
import type { EncryptedContent } from '../lexicon/types';
import { decrypt, encrypt, fromB64, generateNoteKey, toB64, unwrapKey, wrapKey } from './box';

export interface NotePayload {
  path: string;
  title: string;
  body: string;
}

export async function encryptNote(
  payload: NotePayload,
  masterKey: Uint8Array
): Promise<EncryptedContent> {
  await sodium.ready;
  const noteKey = await generateNoteKey();
  const plaintext = JSON.stringify({ ...payload, path: payload.path.normalize('NFC') });
  const contentBox = await encrypt(new TextEncoder().encode(plaintext), noteKey);
  const wrapped = await wrapKey(noteKey, masterKey);
  return {
    keyId: sodium.to_hex(sodium.randombytes_buf(8)),
    wrappedKey: await toB64(wrapped.ciphertext),
    keyNonce: await toB64(wrapped.nonce),
    contentNonce: await toB64(contentBox.nonce),
    ciphertext: await toB64(contentBox.ciphertext),
  };
}

export async function decryptNote(
  enc: EncryptedContent,
  masterKey: Uint8Array
): Promise<NotePayload> {
  const noteKey = await unwrapKey(
    { nonce: await fromB64(enc.keyNonce), ciphertext: await fromB64(enc.wrappedKey) },
    masterKey
  );
  const plain = await decrypt(
    { nonce: await fromB64(enc.contentNonce), ciphertext: await fromB64(enc.ciphertext) },
    noteKey
  );
  return JSON.parse(new TextDecoder().decode(plain)) as NotePayload;
}
