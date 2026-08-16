import { describe, it, expect } from 'vitest';
import { CasError } from '../../src/sync/pds';
import { FakePds } from '../../src/sync/fake-pds';

describe('FakePds', () => {
  it('round-trips put and get', async () => {
    const pds = new FakePds();
    const { cid } = await pds.putRecord('app.notesky.note', 'k1', { a: 1 });
    const got = await pds.getRecord('app.notesky.note', 'k1');
    expect(got).toEqual({ cid, value: { a: 1 } });
  });

  it('returns null for a missing record', async () => {
    const pds = new FakePds();
    expect(await pds.getRecord('app.notesky.note', 'nope')).toBeNull();
  });

  it('lists all records in a collection', async () => {
    const pds = new FakePds();
    await pds.putRecord('c', 'k1', { a: 1 });
    await pds.putRecord('c', 'k2', { a: 2 });
    const list = await pds.listRecords('c');
    expect(list.map((r) => r.rkey).sort()).toEqual(['k1', 'k2']);
  });

  it('CAS put succeeds with the current cid and the cid changes on every put', async () => {
    const pds = new FakePds();
    const { cid: cid1 } = await pds.putRecord('c', 'k', { v: 1 });
    const { cid: cid2 } = await pds.putRecord('c', 'k', { v: 2 }, cid1);
    expect(cid2).not.toBe(cid1);
    expect((await pds.getRecord('c', 'k'))?.value).toEqual({ v: 2 });
  });

  it('CAS put with a stale cid throws CasError', async () => {
    const pds = new FakePds();
    const { cid: stale } = await pds.putRecord('c', 'k', { v: 1 });
    await pds.putRecord('c', 'k', { v: 2 });
    await expect(pds.putRecord('c', 'k', { v: 3 }, stale)).rejects.toThrow(CasError);
  });

  it('put with swapCid null (must-not-exist) throws CasError when the record exists', async () => {
    const pds = new FakePds();
    await pds.putRecord('c', 'k', { v: 1 });
    await expect(pds.putRecord('c', 'k', { v: 2 }, null)).rejects.toThrow(CasError);
  });

  it('put with swapCid null succeeds when the record does not exist', async () => {
    const pds = new FakePds();
    const { cid } = await pds.putRecord('c', 'k', { v: 1 }, null);
    expect(cid).toBeTruthy();
  });

  it('applyCreates writes a batch atomically and returns cids in order', async () => {
    const pds = new FakePds();
    const results = await pds.applyCreates([
      { collection: 'c', rkey: 'k1', value: { v: 1 } },
      { collection: 'c', rkey: 'k2', value: { v: 2 } },
    ]);
    expect(results).toHaveLength(2);
    expect((await pds.getRecord('c', 'k1'))?.cid).toBe(results[0].cid);
    expect((await pds.getRecord('c', 'k2'))?.cid).toBe(results[1].cid);
  });

  it('applyCreates applies nothing when any record already exists', async () => {
    const pds = new FakePds();
    await pds.putRecord('c', 'k2', { existing: true });
    await expect(
      pds.applyCreates([
        { collection: 'c', rkey: 'k1', value: { v: 1 } },
        { collection: 'c', rkey: 'k2', value: { v: 2 } },
      ])
    ).rejects.toThrow(CasError);
    expect(await pds.getRecord('c', 'k1')).toBeNull(); // atomic: k1 not written
  });

  it('delete removes the record; delete with a stale cid throws', async () => {
    const pds = new FakePds();
    const { cid: stale } = await pds.putRecord('c', 'k', { v: 1 });
    await pds.putRecord('c', 'k', { v: 2 });
    await expect(pds.deleteRecord('c', 'k', stale)).rejects.toThrow(CasError);
    await pds.deleteRecord('c', 'k');
    expect(await pds.getRecord('c', 'k')).toBeNull();
  });
});
