import { describe, it, expect } from 'vitest';
import { login } from '@atproto-sync/core/atproto/pds-client';
import { RepoSubscription } from '../src/subscription';
import { waitFor } from './helpers';

const url = process.env.NOTESKY_PDS_URL;
const handle = process.env.NOTESKY_HANDLE;
const password = process.env.NOTESKY_PASSWORD;

describe.skipIf(!url || !handle || !password)('subscribeRepos against a live PDS', () => {
  it('reports our own notesky write within a few seconds', async () => {
    const pds = await login({ identifier: handle!, password: password!, pdsUrl: url! });
    let relevant = 0;
    let subscribed = false;
    const sub = new RepoSubscription({
      resolveTarget: async () => ({ pdsUrl: url!, did: pds.did }),
      onRelevant: () => relevant++,
      onState: (s) => (subscribed = s === 'subscribed'),
    });
    sub.start();
    try {
      await waitFor(() => subscribed, 5000);
      const rkey = `live${Date.now().toString(36)}`;
      await pds.putRecord(
        'app.notesky.tombstone',
        rkey,
        {
          $type: 'app.notesky.tombstone',
          vault: 'live-test',
          target: 'live-test-target',
          collection: 'app.notesky.note',
          deletedAt: new Date().toISOString(),
        },
        null
      );
      await waitFor(() => relevant > 0, 10_000);
      await pds.deleteRecord('app.notesky.tombstone', rkey);
    } finally {
      sub.stop();
    }
    expect(relevant).toBeGreaterThan(0);
  }, 30_000);
});
