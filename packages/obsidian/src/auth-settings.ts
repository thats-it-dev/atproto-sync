export type AuthMode = 'oauth' | 'app-password';

export interface AtprotoSyncSettings {
  identifier: string;
  appPassword: string;
  /** The sign-in method the user chose; only that method's credentials are used. */
  authMode: AuthMode;
  /** DID of the OAuth session to restore on load. */
  authDid: string;
  /** Direct PDS URL, skipping handle resolution (self-hosted / local testing). */
  pdsUrlOverride: string;
  /** rkey of the app.notesky.vault record; set during onboarding. */
  vaultRkey: string;
  /** Cached master key (base64, device-local); set after passphrase entry. */
  masterKeyB64: string;
  syncIntervalMinutes: number;
  ignorePatterns: string[];
  /** True after an abandoned setup was rolled back; drives the alert status icon. */
  setupIncomplete: boolean;
}

export const DEFAULT_SETTINGS: AtprotoSyncSettings = {
  identifier: '',
  appPassword: '',
  authMode: 'oauth',
  authDid: '',
  pdsUrlOverride: '',
  vaultRkey: '',
  masterKeyB64: '',
  syncIntervalMinutes: 5,
  ignorePatterns: [],
  setupIncomplete: false,
};

/**
 * Merge saved settings over the defaults. A saved blob without an authMode
 * keeps whichever credential it holds rather than taking the new default.
 */
export function resolveSettings(saved: Partial<AtprotoSyncSettings> | null): AtprotoSyncSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  if (!saved?.authMode) {
    merged.authMode = !merged.authDid && merged.appPassword ? 'app-password' : 'oauth';
  }
  return merged;
}

/** Whether the chosen method has the credentials it needs. */
export function hasAuth(s: AtprotoSyncSettings): boolean {
  return s.authMode === 'oauth' ? Boolean(s.authDid) : Boolean(s.identifier && s.appPassword);
}
