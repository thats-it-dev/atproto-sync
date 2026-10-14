import { describe, it, expect } from 'vitest';
import { deriveMasterKey, generateSalt, DEFAULT_KDF_PARAMS } from '../../src/crypto/keys';

describe('deriveMasterKey', () => {
  it('is deterministic for same passphrase+salt and differs across salts', async () => {
    const salt = await generateSalt();
    const a = await deriveMasterKey('correct horse', salt, DEFAULT_KDF_PARAMS);
    const b = await deriveMasterKey('correct horse', salt, DEFAULT_KDF_PARAMS);
    const c = await deriveMasterKey('correct horse', await generateSalt(), DEFAULT_KDF_PARAMS);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.length).toBe(32);
  });
});
