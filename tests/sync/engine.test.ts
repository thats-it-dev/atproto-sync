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

  it('batches initial-sync creates through applyCreates in chunks of 10 with progress', async () => {
    const pds = new FakePds();
    let applyCalls = 0;
    let putCalls = 0;
    const spyPds = new Proxy(pds, {
      get(target, prop, receiver) {
        if (prop === 'applyCreates') {
          return (writes: Array<{ collection: string; rkey: string; value: unknown }>) => {
            applyCalls++;
            expect(writes.length).toBeLessThanOrEqual(10);
            return target.applyCreates(writes);
          };
        }
        if (prop === 'putRecord') {
          return (...args: [string, string, unknown, (string | null)?]) => {
            putCalls++;
            return target.putRecord(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const progress: Array<[number, number]> = [];
    const a = makeEngine(spyPds, new Uint8Array(32).fill(3), {
      onProgress: (done, total) => progress.push([done, total]),
    });
    for (let i = 0; i < 25; i++) await a.vault.write(`n${i}.md`, `content ${i}`);
    await a.engine.sync();

    expect(applyCalls).toBe(3); // 10 + 10 + 5
    expect(putCalls).toBe(0); // creates all went through the batch path
    expect((await pds.listRecords('app.notesky.note')).length).toBe(25);
    expect(progress[progress.length - 1]).toEqual([25, 25]);
  });

  it('resumes an interrupted initial sync without duplicates', async () => {
    const pds = new FakePds();
    let failAfter = 1; // let one batch through, then die
    const flakyPds = new Proxy(pds, {
      get(target, prop, receiver) {
        if (prop === 'applyCreates') {
          return (writes: Array<{ collection: string; rkey: string; value: unknown }>) => {
            if (failAfter-- <= 0) throw new Error('network down');
            return target.applyCreates(writes);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const master = new Uint8Array(32).fill(3);
    const a = makeEngine(flakyPds, master);
    for (let i = 0; i < 30; i++) await a.vault.write(`n${i}.md`, `content ${i}`);

    await expect(a.engine.sync()).rejects.toThrow('network down');
    // Partial progress must be persisted so the retry doesn't redo work.
    expect(a.index.entries.length).toBe(10);

    failAfter = Infinity;
    await a.engine.sync();
    const records = await pds.listRecords('app.notesky.note');
    expect(records.length).toBe(30);

    const b = makeEngine(pds, master);
    await b.engine.sync();
    expect(b.vault.files.size).toBe(30);
    expect(await b.vault.read('n29.md')).toBe('content 29');
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
