/**
 * Handle -> DID -> PDS endpoint resolution for plain Node (port of
 * src/obsidian/login.ts, which uses Obsidian's requestUrl; here we use fetch).
 */
export async function resolvePdsUrl(handle: string): Promise<{ did: string; pdsUrl: string }> {
  let didJson: unknown;
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
    );
    if (!res.ok) throw new Error(`resolveHandle returned ${res.status}`);
    didJson = await res.json();
  } catch (err) {
    throw new Error(`Could not resolve handle ${handle}: ${String((err as Error).message)}`);
  }
  const { did } = didJson as { did: string };
  if (!did) throw new Error(`Could not resolve handle ${handle}`);

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
    const docRes = await fetch(didDocUrl);
    if (!docRes.ok) throw new Error(`DID document request returned ${docRes.status}`);
    doc = await docRes.json();
  } catch (err) {
    throw new Error(`Could not fetch DID document for ${did}: ${String((err as Error).message)}`);
  }
  const pds = doc.service?.find((s) => s.id === '#atproto_pds' || s.id.endsWith('#atproto_pds'));
  if (!pds) throw new Error(`No PDS endpoint in DID document for ${did}`);
  return { did, pdsUrl: pds.serviceEndpoint };
}
