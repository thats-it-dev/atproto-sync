import sodium from 'libsodium-wrappers-sumo';

export interface Box {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export async function generateNoteKey(): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
}

export async function encrypt(message: Uint8Array, key: Uint8Array): Promise<Box> {
  await sodium.ready;
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    message,
    null,
    null,
    nonce,
    key
  );
  return { nonce, ciphertext };
}

export async function decrypt(box: Box, key: Uint8Array): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    box.ciphertext,
    null,
    box.nonce,
    key
  );
}

export async function wrapKey(noteKey: Uint8Array, masterKey: Uint8Array): Promise<Box> {
  return encrypt(noteKey, masterKey);
}

export async function unwrapKey(wrapped: Box, masterKey: Uint8Array): Promise<Uint8Array> {
  return decrypt(wrapped, masterKey);
}

export async function toB64(bytes: Uint8Array): Promise<string> {
  await sodium.ready;
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export async function fromB64(b64: string): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.from_base64(b64, sodium.base64_variants.URLSAFE_NO_PADDING);
}
