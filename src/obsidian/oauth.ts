import type { OAuthSession } from '@atproto/oauth-client';
import { BrowserOAuthClient } from '@atproto/oauth-client-browser';

/**
 * Must stay in sync with site/oauth/client-metadata.json — the authorization
 * server fetches that hosted copy; this local copy shapes our requests.
 */
const CLIENT_METADATA = {
  client_id: 'https://notesky.app/oauth/client-metadata.json',
  client_name: 'Notesky Sync',
  client_uri: 'https://notesky.app',
  redirect_uris: ['https://notesky.app/oauth/callback'] as [string],
  scope:
    'atproto repo:app.notesky.note repo:app.notesky.attachment repo:app.notesky.tombstone repo:app.notesky.vault blob:*/*',
  grant_types: ['authorization_code', 'refresh_token'] as ['authorization_code', 'refresh_token'],
  response_types: ['code'] as ['code'],
  token_endpoint_auth_method: 'none' as const,
  application_type: 'web' as const,
  dpop_bound_access_tokens: true,
};

/**
 * ATProto OAuth for Obsidian: the flow starts in the system browser and
 * returns via the obsidian://notesky-auth protocol handler (bounced through
 * https://notesky.app/oauth/callback). BrowserOAuthClient persists sessions
 * and DPoP keys in IndexedDB and auto-refreshes tokens.
 */
export class NoteskyOAuth {
  private readonly client: BrowserOAuthClient;

  constructor() {
    this.client = new BrowserOAuthClient({
      clientMetadata: CLIENT_METADATA,
      responseMode: 'query',
      handleResolver: 'https://public.api.bsky.app',
    });
  }

  /**
   * Build the authorization URL for the user's PDS login page. The caller
   * decides how to open it: window.open works on desktop, but mobile WebViews
   * need a real user tap on a real anchor.
   */
  async createAuthUrl(handle: string): Promise<string> {
    const url = await this.client.authorize(handle);
    return url.toString();
  }

  /** Complete the flow with the params delivered to obsidian://notesky-auth. */
  async completeCallback(params: Record<string, string>): Promise<OAuthSession> {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (key !== 'action') searchParams.set(key, value);
    }
    const { session } = await this.client.initCallback(searchParams);
    return session;
  }

  /** Restore a persisted session (refreshing tokens if needed). */
  async restore(did: string): Promise<OAuthSession> {
    return this.client.restore(did);
  }

  async logout(did: string): Promise<void> {
    await this.client.revoke(did);
  }
}
