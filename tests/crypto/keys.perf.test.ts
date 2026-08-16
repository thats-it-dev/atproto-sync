import { describe, it, expect } from 'vitest';
import { deriveMasterKey, generateSalt, DEFAULT_KDF_PARAMS } from '../../src/crypto/keys';

describe('Argon2id timing', () => {
  it('derives a key with mobile-tuned params well under the 2s budget', async () => {
    const salt = await generateSalt();
    await deriveMasterKey('warmup', salt, DEFAULT_KDF_PARAMS); // exclude wasm init
    const start = performance.now();
    await deriveMasterKey('correct horse battery staple', salt, DEFAULT_KDF_PARAMS);
    const elapsed = performance.now() - start;
    // Mobile-class budget is <2000ms; desktop CI should be far below it. A
    // desktop result over 1s would blow the mobile budget — flag it here.
    console.log(`Argon2id (ops=${DEFAULT_KDF_PARAMS.opsLimit}, mem=${DEFAULT_KDF_PARAMS.memLimit / 1024 / 1024}MB): ${elapsed.toFixed(0)}ms`);
    expect(elapsed).toBeLessThan(1000);
  });
});
