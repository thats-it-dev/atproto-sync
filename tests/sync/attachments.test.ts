import { describe, it, expect } from 'vitest';
import { FakePds } from '../../src/sync/fake-pds';
import { ATTACHMENT_COLLECTION, TOMBSTONE_COLLECTION } from '../../src/lexicon/build';
import { makeEngine } from './helpers';

const MASTER = new Uint8Array(32).fill(3);
const IMG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

describe('attachment sync', () => {
  it('round-trips an image A→B, encrypted at rest with hidden filename', async () => {
    const pds = new FakePds();
    const a = makeEngine(pds, MASTER);
    const b = makeEngine(pds, MASTER);
    await a.vault.writeBinary('img/Secret Chart.png', IMG);
    await a.engine.sync();

    const raw = JSON.stringify(await pds.listRecords(ATTACHMENT_COLLECTION));
    expect(raw).not.toContain('Secret Chart');
    expect((await pds.listRecords(ATTACHMENT_COLLECTION)).length).toBe(1);

    await b.engine.sync();
    expect(await b.vault.readBinary('img/Secret Chart.png')).toEqual(IMG);
  });

  it('propagates binary edit and delete with tombstones', async () => {
    const pds = new FakePds();
    const a = makeEngine(pds, MASTER);
    const b = makeEngine(pds, MASTER);
    await a.vault.writeBinary('doc.pdf', IMG);
    await a.engine.sync();
    await b.engine.sync();

    const edited = Uint8Array.from([1, 1, 2, 3, 5, 8]);
    await a.vault.writeBinary('doc.pdf', edited);
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.vault.readBinary('doc.pdf')).toEqual(edited);

    await b.vault.remove('doc.pdf');
    await b.engine.sync();
    await a.engine.sync();
    expect(a.vault.binaries.has('doc.pdf')).toBe(false);
    expect((await pds.listRecords(ATTACHMENT_COLLECTION)).length).toBe(0);
    expect((await pds.listRecords(TOMBSTONE_COLLECTION)).length).toBe(1);
  });

  it('rename updates the record without changing rkey', async () => {
    const pds = new FakePds();
    const a = makeEngine(pds, MASTER);
    const b = makeEngine(pds, MASTER);
    await a.vault.writeBinary('old.png', IMG);
    await a.engine.sync();
    await b.engine.sync();
    const rkey = (await pds.listRecords(ATTACHMENT_COLLECTION))[0].rkey;

    await a.vault.remove('old.png');
    await a.vault.writeBinary('new.png', IMG);
    await a.engine.sync();
    await b.engine.sync();

    const records = await pds.listRecords(ATTACHMENT_COLLECTION);
    expect(records.length).toBe(1);
    expect(records[0].rkey).toBe(rkey);
    expect(await b.vault.readBinary('new.png')).toEqual(IMG);
    expect(b.vault.binaries.has('old.png')).toBe(false);
  });

  it('conflicting binary edits: remote stands, local stashed with a warning', async () => {
    const pds = new FakePds();
    const warnings: string[] = [];
    const a = makeEngine(pds, MASTER, { onWarning: (m) => warnings.push(m) });
    const b = makeEngine(pds, MASTER);
    await a.vault.writeBinary('logo.png', IMG);
    await a.engine.sync();
    await b.engine.sync();

    const aEdit = Uint8Array.from([10, 10, 10]);
    const bEdit = Uint8Array.from([20, 20, 20]);
    await a.vault.writeBinary('logo.png', aEdit);
    await b.vault.writeBinary('logo.png', bEdit);
    await b.engine.sync();
    await a.engine.sync();

    expect(await a.vault.readBinary('logo.png')).toEqual(bEdit); // remote stands
    const stash = [...a.vault.binaries.keys()].filter((p) => p.startsWith('Notesky Conflicts/'));
    expect(stash).toHaveLength(1);
    expect(await a.vault.readBinary(stash[0])).toEqual(aEdit);
    expect(warnings.some((w) => w.includes('logo.png'))).toBe(true);

    await b.engine.sync();
    expect(await b.vault.readBinary('logo.png')).toEqual(bEdit);
    expect((await pds.listRecords(ATTACHMENT_COLLECTION)).length).toBe(1);
  });

  it('publishes embedded attachments of public notes, re-encrypts when unflagged', async () => {
    const pds = new FakePds();
    const a = makeEngine(pds, MASTER);
    await a.vault.writeBinary('img/chart.png', IMG);
    await a.vault.write('post.md', '---\nnotesky_public: true\n---\n\n![[img/chart.png]]\n');
    await a.engine.sync();

    let records = await pds.listRecords(ATTACHMENT_COLLECTION);
    expect(records.length).toBe(1);
    let value = records[0].value as { meta: Record<string, unknown>; blob: { ref: { $link: string } } };
    expect(value.meta.path).toBe('img/chart.png'); // plaintext meta
    expect(value.meta.mimeType).toBe('image/png');
    expect(await pds.getBlob(value.blob.ref.$link)).toEqual(IMG); // blob unencrypted

    // Remove the flag: attachment re-encrypts.
    await a.vault.write('post.md', '\n![[img/chart.png]]\n');
    await a.engine.sync();
    records = await pds.listRecords(ATTACHMENT_COLLECTION);
    expect(records.length).toBe(1);
    value = records[0].value as typeof value;
    expect(value.meta.path).toBeUndefined(); // encrypted meta again
    expect(await pds.getBlob(value.blob.ref.$link)).not.toEqual(IMG);
  });

  it('an attachment stays public while any public note still embeds it', async () => {
    const pds = new FakePds();
    const a = makeEngine(pds, MASTER);
    await a.vault.writeBinary('shared.png', IMG);
    await a.vault.write('one.md', '---\nnotesky_public: true\n---\n\n![[shared.png]]\n');
    await a.vault.write('two.md', '---\nnotesky_public: true\n---\n\n![[shared.png]]\n');
    await a.engine.sync();

    await a.vault.write('one.md', '\n![[shared.png]]\n'); // one goes private
    await a.engine.sync();
    const value = (await pds.listRecords(ATTACHMENT_COLLECTION))[0].value as {
      meta: Record<string, unknown>;
    };
    expect(value.meta.path).toBe('shared.png'); // still public via two.md
  });

  it('oversized files are skipped with a warning and nothing synced', async () => {
    const pds = new FakePds({ blobLimit: 64 });
    const warnings: string[] = [];
    const a = makeEngine(pds, MASTER, { onWarning: (m) => warnings.push(m) });
    await a.vault.writeBinary('video.mp4', new Uint8Array(200));
    await a.vault.writeBinary('small.png', IMG);
    await a.engine.sync();

    expect((await pds.listRecords(ATTACHMENT_COLLECTION)).length).toBe(1); // small only
    expect(warnings.some((w) => w.includes('video.mp4'))).toBe(true);
    expect(a.engine.lastSkippedPaths).toEqual(['video.mp4']);
  });
});
