import { describe, it, expect } from 'vitest';
import { makeCheckValue, verifyCheckValue } from '../../src/crypto/check';
import { deriveMasterKey, generateSalt, DEFAULT_KDF_PARAMS } from '../../src/crypto/keys';

describe('passphrase check value', () => {
  it('verifies with the right master key and rejects a wrong one without throwing', async () => {
    const salt = await generateSalt();
    const master = await deriveMasterKey('right passphrase', salt, DEFAULT_KDF_PARAMS);
    const wrong = await deriveMasterKey('wrong passphrase', salt, DEFAULT_KDF_PARAMS);
    const check = await makeCheckValue(master);
    expect(await verifyCheckValue(check, master)).toBe(true);
    expect(await verifyCheckValue(check, wrong)).toBe(false);
  });
});
