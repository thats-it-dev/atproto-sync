import { describe, it, expect } from 'vitest';
import { login } from '../../src/obsidian/pds-client';
import { CasError } from '../../src/sync/pds';

/**
 * Integration test against a real PDS. Skipped unless configured; run manually with:
 *
 *   docker run -d -p 3000:3000 -e PDS_DEV_MODE=true ... ghcr.io/bluesky-social/pds
 *   NOTESKY_PDS_URL=http://localhost:3000 \
 *   NOTESKY_HANDLE=test.example NOTESKY_PASSWORD=... npx vitest run tests/obsidian/pds-client.integration.test.ts
 */
const url = process.env.NOTESKY_PDS_URL;
const handle = process.env.NOTESKY_HANDLE;
const password = process.env.NOTESKY_PASSWORD;

describe.skipIf(!url || !handle || !password)('RealPdsClient against a live PDS', () => {
  const COLLECTION = 'app.notesky.note';

  it('exercises put/get/list/delete with CAS semantics', async () => {
    const client = await login({ identifier: handle!, password: password!, pdsUrl: url! });
    const rkey = `test${Date.now().toString(36)}`;
    const record = {
      $type: COLLECTION,
      vault: 'integration-test',
      formatVersion: 1,
      updatedAt: new Date().toISOString(),
      contentHash: '0'.repeat(64),
      content: {
        keyId: 'k',
        wrappedKey: 'a',
        keyNonce: 'b',
        contentNonce: 'c',
        ciphertext: 'd',
      },
    };

    // create (must not exist)
    const { cid: cid1 } = await client.putRecord(COLLECTION, rkey, record, null);
    // create again must fail CAS
    await expect(client.putRecord(COLLECTION, rkey, record, null)).rejects.toThrow(CasError);
    // get
    const got = await client.getRecord(COLLECTION, rkey);
    expect(got?.cid).toBe(cid1);
    // CAS update with current cid
    const { cid: cid2 } = await client.putRecord(COLLECTION, rkey, record, cid1);
    expect(cid2).not.toBe(cid1);
    // CAS update with stale cid must fail
    await expect(client.putRecord(COLLECTION, rkey, record, cid1)).rejects.toThrow(CasError);
    // list contains the record
    const list = await client.listRecords(COLLECTION);
    expect(list.some((r) => r.rkey === rkey)).toBe(true);
    // stale delete fails, current delete succeeds
    await expect(client.deleteRecord(COLLECTION, rkey, cid1)).rejects.toThrow(CasError);
    await client.deleteRecord(COLLECTION, rkey, cid2);
    expect(await client.getRecord(COLLECTION, rkey)).toBeNull();
  });
});
