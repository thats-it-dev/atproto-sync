import { describe, it, expect } from 'vitest';
import { NOTE_COLLECTION, TOMBSTONE_COLLECTION } from '../../src/lexicon/build';
import { login } from '../../src/obsidian/pds-client';
import { makeEngine } from './helpers';

/**
 * Full engine loop against a live PDS (see pds-client.integration.test.ts for
 * the Docker setup). Uses the account's real repo; wipes app.notesky.* first.
 */
const url = process.env.NOTESKY_PDS_URL;
const handle = process.env.NOTESKY_HANDLE;
const password = process.env.NOTESKY_PASSWORD;

describe.skipIf(!url || !handle || !password)('SyncEngine against a live PDS', () => {
  it('two devices converge through the real server, encrypted at rest', async () => {
    const client = await login({ identifier: handle!, password: password!, pdsUrl: url! });
    for (const col of [NOTE_COLLECTION, TOMBSTONE_COLLECTION]) {
      for (const r of await client.listRecords(col)) await client.deleteRecord(col, r.rkey);
    }

    const master = new Uint8Array(32).fill(5);
    // A uses the production rkey generator so the real PDS validates its format.
    const a = makeEngine(client, master, { rkeyGen: undefined });
    const b = makeEngine(client, master);

    // 15 files forces two applyCreates batches; one is a public note.
    for (let i = 0; i < 14; i++) await a.vault.write(`notes/n${i}.md`, `content ${i}`);
    await a.vault.write(
      'public.md',
      '---\nnotesky_public: true\nnotesky_slug: hello\n---\n\npublic body\n'
    );
    await a.engine.sync();

    const records = await client.listRecords(NOTE_COLLECTION);
    expect(records.length).toBe(15);
    const raw = JSON.stringify(records);
    expect(raw).not.toContain('content 3');
    expect(raw).not.toContain('notes/n3.md');
    expect(raw).toContain('public body');
    expect(raw).toContain('"slug":"hello"');

    await b.engine.sync();
    expect(b.vault.files.size).toBe(15);
    expect(await b.vault.read('notes/n3.md')).toBe('content 3');

    // Concurrent edit (A) and delete (B), then settle.
    await a.vault.write('notes/n3.md', 'content 3 EDITED');
    await b.vault.remove('notes/n7.md');
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();

    expect(await b.vault.read('notes/n3.md')).toBe('content 3 EDITED');
    expect(a.vault.files.has('notes/n7.md')).toBe(false);
    expect((await client.listRecords(NOTE_COLLECTION)).length).toBe(14);
    expect((await client.listRecords(TOMBSTONE_COLLECTION)).length).toBe(1);
  }, 60_000);
});
