import sodium from 'libsodium-wrappers-sumo';
import type { EncryptedAttachmentMeta } from '../lexicon/types';
import { sha256Hex } from '../lexicon/build';
import { decrypt, encrypt, fromB64, generateNoteKey, toB64, unwrapKey, wrapKey } from './box';

export interface AttachmentMetaPayload {
  path: string;
  mimeType: string;
  /** sha256 hex of the plaintext bytes: lets devices reconcile without downloading blobs. */
  hash: string;
}

export interface AttachmentMetaInput {
  path: string;
  mimeType: string;
}

export async function encryptAttachment(
  bytes: Uint8Array,
  meta: AttachmentMetaInput,
  masterKey: Uint8Array
): Promise<{ meta: EncryptedAttachmentMeta; blob: Uint8Array }> {
  await sodium.ready;
  const key = await generateNoteKey();
  const blobBox = await encrypt(bytes, key);
  const payload: AttachmentMetaPayload = {
    path: meta.path.normalize('NFC'),
    mimeType: meta.mimeType,
    hash: await sha256Hex(bytes),
  };
  const metaBox = await encrypt(new TextEncoder().encode(JSON.stringify(payload)), key);
  const wrapped = await wrapKey(key, masterKey);
  return {
    meta: {
      keyId: sodium.to_hex(sodium.randombytes_buf(8)),
      wrappedKey: await toB64(wrapped.ciphertext),
      keyNonce: await toB64(wrapped.nonce),
      blobNonce: await toB64(blobBox.nonce),
      metaNonce: await toB64(metaBox.nonce),
      ciphertext: await toB64(metaBox.ciphertext),
    },
    blob: blobBox.ciphertext,
  };
}

async function unwrapAttachmentKey(
  meta: EncryptedAttachmentMeta,
  masterKey: Uint8Array
): Promise<Uint8Array> {
  return unwrapKey(
    { nonce: await fromB64(meta.keyNonce), ciphertext: await fromB64(meta.wrappedKey) },
    masterKey
  );
}

export async function decryptAttachmentMeta(
  meta: EncryptedAttachmentMeta,
  masterKey: Uint8Array
): Promise<AttachmentMetaPayload> {
  const key = await unwrapAttachmentKey(meta, masterKey);
  const plain = await decrypt(
    { nonce: await fromB64(meta.metaNonce), ciphertext: await fromB64(meta.ciphertext) },
    key
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

export async function decryptAttachmentBlob(
  meta: EncryptedAttachmentMeta,
  blobCiphertext: Uint8Array,
  masterKey: Uint8Array
): Promise<Uint8Array> {
  const key = await unwrapAttachmentKey(meta, masterKey);
  return decrypt({ nonce: await fromB64(meta.blobNonce), ciphertext: blobCiphertext }, key);
}
