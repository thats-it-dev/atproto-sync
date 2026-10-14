import {
  Agent,
  AtpAgent,
  ComAtprotoRepoApplyWrites,
  ComAtprotoRepoDeleteRecord,
  ComAtprotoRepoGetRecord,
  ComAtprotoRepoPutRecord,
  XRPCError,
} from '@atproto/api';
import { BlobTooLargeError, CasError, PdsClient } from '../sync/pds';

const DEFAULT_BLOB_LIMIT = 5 * 1024 * 1024; // reference PDS default

/** Translate PDS transport errors into messages a user can act on. */
function mapPdsError(err: unknown): unknown {
  if (err instanceof XRPCError) {
    if (Number(err.status) === 429 || err.error === 'RateLimitExceeded') {
      return new Error('Your PDS is rate-limiting requests; sync will retry on the next interval.');
    }
    if (Number(err.status) === 507 || /quota|too large|storage/i.test(err.error ?? '')) {
      return new Error('Your PDS reports it is out of storage; free space or contact your host.');
    }
  }
  return err;
}

/** PdsClient over a logged-in Agent (app-password AtpAgent or OAuth session), scoped to the account's own repo. */
export class RealPdsClient implements PdsClient {
  constructor(
    private readonly agent: Agent,
    private readonly did: string
  ) {}

  async putRecord(
    collection: string,
    rkey: string,
    value: unknown,
    swapCid?: string | null
  ): Promise<{ cid: string }> {
    // swapCid === null means must-not-exist. The reference PDS does not
    // enforce that through putRecord (the null swap never takes effect), so
    // creates go through createRecord, which does reject duplicates.
    if (swapCid === null) {
      try {
        const res = await this.agent.com.atproto.repo.createRecord({
          repo: this.did,
          collection,
          rkey,
          record: value as Record<string, unknown>,
          validate: false,
        });
        return { cid: res.data.cid };
      } catch (err) {
        throw await this.mapCreateError(err, collection, [rkey]);
      }
    }
    try {
      const res = await this.agent.com.atproto.repo.putRecord({
        repo: this.did,
        collection,
        rkey,
        record: value as Record<string, unknown>,
        // Custom lexicon: the PDS can't validate app.notesky.* schemas.
        validate: false,
        ...(swapCid !== undefined ? { swapRecord: swapCid } : {}),
      });
      return { cid: res.data.cid };
    } catch (err) {
      if (err instanceof ComAtprotoRepoPutRecord.InvalidSwapError) {
        throw new CasError(err.message);
      }
      throw mapPdsError(err);
    }
  }

  /**
   * The PDS reports a duplicate create as an untyped 500, so on failure we
   * check whether any of the target records exists to tell a CAS collision
   * apart from a genuine server error.
   */
  private async mapCreateError(
    err: unknown,
    collection: string,
    rkeys: string[]
  ): Promise<unknown> {
    if (err instanceof XRPCError) {
      for (const rkey of rkeys) {
        try {
          if (await this.getRecord(collection, rkey)) {
            return new CasError(`record ${collection}/${rkey} already exists`);
          }
        } catch {
          break; // can't verify; fall through to the original error
        }
      }
    }
    return mapPdsError(err);
  }

  /** Atomic batch create via com.atproto.repo.applyWrites. */
  async applyCreates(
    writes: Array<{ collection: string; rkey: string; value: unknown }>
  ): Promise<Array<{ cid: string }>> {
    try {
      const res = await this.agent.com.atproto.repo.applyWrites({
        repo: this.did,
        validate: false,
        writes: writes.map((w) => ({
          $type: 'com.atproto.repo.applyWrites#create' as const,
          collection: w.collection,
          rkey: w.rkey,
          value: w.value as Record<string, unknown>,
        })),
      });
      const results = res.data.results ?? [];
      return writes.map((_, i) => {
        const r = results[i];
        if (!r || !('cid' in r) || typeof r.cid !== 'string') {
          throw new Error('applyWrites returned no cid for a create');
        }
        return { cid: r.cid };
      });
    } catch (err) {
      if (err instanceof ComAtprotoRepoApplyWrites.InvalidSwapError) {
        throw new CasError(err.message);
      }
      throw await this.mapCreateError(
        err,
        writes[0]?.collection ?? '',
        writes.map((w) => w.rkey)
      );
    }
  }

  async uploadBlob(bytes: Uint8Array, mimeType: string): Promise<{ blob: unknown; ref: string }> {
    try {
      const res = await this.agent.uploadBlob(bytes, { encoding: mimeType });
      return { blob: res.data.blob, ref: res.data.blob.ref.toString() };
    } catch (err) {
      if (
        err instanceof XRPCError &&
        (Number(err.status) === 413 || /too large|blob.*size|payload/i.test(err.message))
      ) {
        throw new BlobTooLargeError(err.message);
      }
      throw mapPdsError(err);
    }
  }

  async getBlob(ref: string): Promise<Uint8Array> {
    try {
      const res = await this.agent.com.atproto.sync.getBlob({ did: this.did, cid: ref });
      return new Uint8Array(res.data);
    } catch (err) {
      throw mapPdsError(err);
    }
  }

  async getBlobLimit(): Promise<number> {
    try {
      const res = await this.agent.com.atproto.server.describeServer();
      // Not part of the published schema today; honor it if a host reports it.
      const reported = (res.data as { blobUploadLimit?: unknown }).blobUploadLimit;
      if (typeof reported === 'number' && reported > 0) return reported;
    } catch {
      // fall through to the default
    }
    return DEFAULT_BLOB_LIMIT;
  }

  async getRecord(
    collection: string,
    rkey: string
  ): Promise<{ cid: string; value: unknown } | null> {
    try {
      const res = await this.agent.com.atproto.repo.getRecord({
        repo: this.did,
        collection,
        rkey,
      });
      return { cid: res.data.cid ?? '', value: res.data.value };
    } catch (err) {
      if (err instanceof ComAtprotoRepoGetRecord.RecordNotFoundError) {
        return null;
      }
      throw mapPdsError(err);
    }
  }

  async listRecords(
    collection: string
  ): Promise<Array<{ rkey: string; cid: string; value: unknown }>> {
    const out: Array<{ rkey: string; cid: string; value: unknown }> = [];
    let cursor: string | undefined;
    do {
      const res = await this.agent.com.atproto.repo.listRecords({
        repo: this.did,
        collection,
        limit: 100,
        cursor,
      });
      for (const rec of res.data.records) {
        out.push({ rkey: rec.uri.split('/').pop()!, cid: rec.cid, value: rec.value });
      }
      cursor = res.data.cursor;
    } while (cursor);
    return out;
  }

  async deleteRecord(collection: string, rkey: string, swapCid?: string): Promise<void> {
    try {
      await this.agent.com.atproto.repo.deleteRecord({
        repo: this.did,
        collection,
        rkey,
        ...(swapCid !== undefined ? { swapRecord: swapCid } : {}),
      });
    } catch (err) {
      if (err instanceof ComAtprotoRepoDeleteRecord.InvalidSwapError) {
        throw new CasError(err.message);
      }
      throw mapPdsError(err);
    }
  }
}

export interface LoginOptions {
  identifier: string;
  password: string;
  /** Skip handle resolution and talk to this PDS directly (tests, self-hosted). */
  pdsUrl?: string;
}

/**
 * App-password login. When no pdsUrl is given, a resolver (handle -> PDS
 * endpoint) must be supplied; the Obsidian layer provides one in login.ts.
 */
export async function login(
  options: LoginOptions,
  resolvePds?: (handle: string) => Promise<{ did: string; pdsUrl: string }>
): Promise<RealPdsClient> {
  if (!options.pdsUrl && !resolvePds) {
    throw new Error('login requires either pdsUrl or a resolver');
  }
  const service = options.pdsUrl ?? (await resolvePds!(options.identifier)).pdsUrl;
  const agent = new AtpAgent({ service });
  const res = await agent.login({
    identifier: options.identifier,
    password: options.password,
  });
  return new RealPdsClient(agent, res.data.did);
}
