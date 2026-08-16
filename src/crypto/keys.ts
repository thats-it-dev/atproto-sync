import sodium from 'libsodium-wrappers-sumo';

export interface KdfParams {
  opsLimit: number;
  memLimit: number;
}

// Tuned down from INTERACTIVE for mobile; revisit in the hardening perf pass.
export const DEFAULT_KDF_PARAMS: KdfParams = { opsLimit: 2, memLimit: 32 * 1024 * 1024 };

export async function generateSalt(): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
}

export async function deriveMasterKey(
  passphrase: string,
  salt: Uint8Array,
  p: KdfParams
): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_pwhash(
    32,
    passphrase.normalize('NFC'),
    salt,
    p.opsLimit,
    p.memLimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
}
