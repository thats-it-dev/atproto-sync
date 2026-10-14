import { Box, decrypt, encrypt } from './box';

const CHECK_STRING = 'notesky-check-v1';

export async function makeCheckValue(masterKey: Uint8Array): Promise<Box> {
  return encrypt(new TextEncoder().encode(CHECK_STRING), masterKey);
}

export async function verifyCheckValue(box: Box, masterKey: Uint8Array): Promise<boolean> {
  try {
    const plain = await decrypt(box, masterKey);
    return new TextDecoder().decode(plain) === CHECK_STRING;
  } catch {
    return false;
  }
}
