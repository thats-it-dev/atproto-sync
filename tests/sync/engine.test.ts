import { describe, it, expect } from 'vitest';
import { FakePds } from '../../src/sync/fake-pds';
import { makeEngine } from './helpers';

describe('SyncEngine', () => {
  it('syncs an edit from device A to device B, encrypted at rest', async () => {
    const pds = new FakePds();
    const master = new Uint8Array(32).fill(3);
    const a = makeEngine(pds, master);
    const b = makeEngine(pds, master);
    await a.vault.write('note.md', 'hello');
    await a.engine.sync();
    // At rest on the PDS: no plaintext visible
    const raw = JSON.stringify(await pds.listRecords('app.notesky.note'));
    expect(raw).not.toContain('hello');
    expect(raw).not.toContain('note.md');
    await b.engine.sync();
    expect(await b.vault.read('note.md')).toBe('hello');
  });
});
