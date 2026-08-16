/** Minimal PDS surface the sync engine needs. Implemented by FakePds (tests) and the real @atproto/api client. */
export interface PdsClient {
  /**
   * swapCid === null means "must not exist" (create);
   * undefined means unconditional; a string means compare-and-swap.
   */
  putRecord(
    collection: string,
    rkey: string,
    value: unknown,
    swapCid?: string | null
  ): Promise<{ cid: string }>;
  getRecord(collection: string, rkey: string): Promise<{ cid: string; value: unknown } | null>;
  listRecords(collection: string): Promise<Array<{ rkey: string; cid: string; value: unknown }>>;
  deleteRecord(collection: string, rkey: string, swapCid?: string): Promise<void>;
  /**
   * Atomic batch create (each record must not exist). Optional: the engine
   * falls back to per-record putRecord when absent.
   */
  applyCreates?(
    writes: Array<{ collection: string; rkey: string; value: unknown }>
  ): Promise<Array<{ cid: string }>>;
}

export class CasError extends Error {
  constructor(message = 'compare-and-swap failed') {
    super(message);
    this.name = 'CasError';
  }
}
