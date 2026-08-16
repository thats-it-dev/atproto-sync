import { CasError, PdsClient } from './pds';

/** In-memory PdsClient with real CAS semantics. Fake cids are just unique strings. */
export class FakePds implements PdsClient {
  private collections = new Map<string, Map<string, { cid: string; value: unknown }>>();
  private cidCounter = 0;

  private nextCid(): string {
    return `cid-${++this.cidCounter}`;
  }

  private collection(name: string): Map<string, { cid: string; value: unknown }> {
    let col = this.collections.get(name);
    if (!col) {
      col = new Map();
      this.collections.set(name, col);
    }
    return col;
  }

  async putRecord(
    collection: string,
    rkey: string,
    value: unknown,
    swapCid?: string | null
  ): Promise<{ cid: string }> {
    const col = this.collection(collection);
    const existing = col.get(rkey);
    if (swapCid === null && existing) {
      throw new CasError(`record ${collection}/${rkey} already exists`);
    }
    if (typeof swapCid === 'string' && existing?.cid !== swapCid) {
      throw new CasError(`stale cid for ${collection}/${rkey}`);
    }
    const cid = this.nextCid();
    col.set(rkey, { cid, value: structuredClone(value) });
    return { cid };
  }

  async getRecord(
    collection: string,
    rkey: string
  ): Promise<{ cid: string; value: unknown } | null> {
    const rec = this.collection(collection).get(rkey);
    return rec ? { cid: rec.cid, value: structuredClone(rec.value) } : null;
  }

  async listRecords(
    collection: string
  ): Promise<Array<{ rkey: string; cid: string; value: unknown }>> {
    return [...this.collection(collection).entries()].map(([rkey, rec]) => ({
      rkey,
      cid: rec.cid,
      value: structuredClone(rec.value),
    }));
  }

  async deleteRecord(collection: string, rkey: string, swapCid?: string): Promise<void> {
    const col = this.collection(collection);
    const existing = col.get(rkey);
    if (typeof swapCid === 'string' && existing?.cid !== swapCid) {
      throw new CasError(`stale cid for ${collection}/${rkey}`);
    }
    col.delete(rkey);
  }
}
