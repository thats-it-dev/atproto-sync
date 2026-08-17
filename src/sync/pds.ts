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
  /**
   * Upload bytes as a blob. `blob` is the opaque BlobRef to embed verbatim in
   * a record (what keeps the blob referenced); `ref` is the cid string for
   * getBlob.
   */
  uploadBlob(bytes: Uint8Array, mimeType: string): Promise<{ blob: unknown; ref: string }>;
  getBlob(ref: string): Promise<Uint8Array>;
  /** Max blob size in bytes accepted by this host. */
  getBlobLimit(): Promise<number>;
}

export class BlobTooLargeError extends Error {
  constructor(message = 'blob exceeds the host size limit') {
    super(message);
    this.name = 'BlobTooLargeError';
  }
}

export class CasError extends Error {
  constructor(message = 'compare-and-swap failed') {
    super(message);
    this.name = 'CasError';
  }
}
