import {
  AtpAgent,
  ComAtprotoRepoDeleteRecord,
  ComAtprotoRepoGetRecord,
  ComAtprotoRepoPutRecord,
} from '@atproto/api';
import { CasError, PdsClient } from '../sync/pds';

/** PdsClient over a logged-in AtpAgent, scoped to the account's own repo. */
export class RealPdsClient implements PdsClient {
  constructor(
    private readonly agent: AtpAgent,
    private readonly did: string
  ) {}

  async putRecord(
    collection: string,
    rkey: string,
    value: unknown,
    swapCid?: string | null
  ): Promise<{ cid: string }> {
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
      throw err;
    }
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
      throw err;
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
      throw err;
    }
  }
}

/** Resolve a handle to its PDS service URL via the public AppView + DID directory. */
export async function resolvePdsUrl(handle: string): Promise<{ did: string; pdsUrl: string }> {
  const res = await fetch(
    `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
  );
  if (!res.ok) throw new Error(`Could not resolve handle ${handle}: ${res.status}`);
  const { did } = (await res.json()) as { did: string };

  let didDocUrl: string;
  if (did.startsWith('did:plc:')) {
    didDocUrl = `https://plc.directory/${did}`;
  } else if (did.startsWith('did:web:')) {
    didDocUrl = `https://${decodeURIComponent(did.slice('did:web:'.length))}/.well-known/did.json`;
  } else {
    throw new Error(`Unsupported DID method: ${did}`);
  }
  const docRes = await fetch(didDocUrl);
  if (!docRes.ok) throw new Error(`Could not fetch DID document for ${did}: ${docRes.status}`);
  const doc = (await docRes.json()) as {
    service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
  };
  const pds = doc.service?.find(
    (s) => s.id === '#atproto_pds' || s.id.endsWith('#atproto_pds')
  );
  if (!pds) throw new Error(`No PDS endpoint in DID document for ${did}`);
  return { did, pdsUrl: pds.serviceEndpoint };
}

export interface LoginOptions {
  identifier: string;
  password: string;
  /** Skip handle resolution and talk to this PDS directly (tests, self-hosted). */
  pdsUrl?: string;
}

/** App-password login: resolve the handle's PDS, authenticate, return a ready client. */
export async function login(options: LoginOptions): Promise<RealPdsClient> {
  const service = options.pdsUrl ?? (await resolvePdsUrl(options.identifier)).pdsUrl;
  const agent = new AtpAgent({ service });
  const res = await agent.login({
    identifier: options.identifier,
    password: options.password,
  });
  return new RealPdsClient(agent, res.data.did);
}
