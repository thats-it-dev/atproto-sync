import { requestUrl } from 'obsidian';
import { LoginOptions, RealPdsClient, login as pdsLogin } from './pds-client';

/**
 * Handle → DID → PDS endpoint resolution using Obsidian's requestUrl (the
 * platform-blessed network API). Lives here, not in pds-client, so the
 * pds-client module stays importable from plain Node for the test suite.
 */
export async function resolvePdsUrl(handle: string): Promise<{ did: string; pdsUrl: string }> {
  let didJson: unknown;
  try {
    const res = await requestUrl({
      url: `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
    });
    didJson = res.json;
  } catch {
    throw new Error(`Could not resolve handle ${handle}`);
  }
  const { did } = didJson as { did: string };

  let didDocUrl: string;
  if (did.startsWith('did:plc:')) {
    didDocUrl = `https://plc.directory/${did}`;
  } else if (did.startsWith('did:web:')) {
    didDocUrl = `https://${decodeURIComponent(did.slice('did:web:'.length))}/.well-known/did.json`;
  } else {
    throw new Error(`Unsupported DID method: ${did}`);
  }
  let doc: { service?: Array<{ id: string; type: string; serviceEndpoint: string }> };
  try {
    const docRes = await requestUrl({ url: didDocUrl });
    doc = docRes.json as typeof doc;
  } catch {
    throw new Error(`Could not fetch DID document for ${did}`);
  }
  const pds = doc.service?.find((s) => s.id === '#atproto_pds' || s.id.endsWith('#atproto_pds'));
  if (!pds) throw new Error(`No PDS endpoint in DID document for ${did}`);
  return { did, pdsUrl: pds.serviceEndpoint };
}

/** App-password login with automatic handle resolution. */
export async function login(options: LoginOptions): Promise<RealPdsClient> {
  return pdsLogin(options, resolvePdsUrl);
}
