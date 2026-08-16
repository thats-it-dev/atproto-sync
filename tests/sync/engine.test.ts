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

  it('stores notes flagged notesky_public as plaintext, and re-encrypts when unflagged', async () => {
    const pds = new FakePds();
    const master = new Uint8Array(32).fill(3);
    const a = makeEngine(pds, master);
    const publicContent = '---\nnotesky_public: true\nnotesky_slug: my-note\n---\n\nvisible body\n';
    await a.vault.write('Blog/My Note.md', publicContent);
    await a.engine.sync();

    let raw = JSON.stringify(await pds.listRecords('app.notesky.note'));
    expect(raw).toContain('visible body');
    expect(raw).toContain('"slug":"my-note"');
    expect(raw).toContain('"title":"My Note"');

    // Remove the flag: the record must be encrypted again.
    await a.vault.write('Blog/My Note.md', '\nvisible body\n');
    await a.engine.sync();
    raw = JSON.stringify(await pds.listRecords('app.notesky.note'));
    expect(raw).not.toContain('visible body');
    expect(raw).not.toContain('My Note');
  });

  it('round-trips a public note to another device unchanged', async () => {
    const pds = new FakePds();
    const master = new Uint8Array(32).fill(3);
    const a = makeEngine(pds, master);
    const b = makeEngine(pds, master);
    const publicContent = '---\nnotesky_public: true\n---\n\npublic body\n';
    await a.vault.write('post.md', publicContent);
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.vault.read('post.md')).toBe(publicContent);
  });
});
