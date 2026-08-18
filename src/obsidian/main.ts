import { Notice, Plugin } from 'obsidian';
import { Agent } from '@atproto/api';
import { SyncEngine } from '../sync/engine';
import { fromB64 } from '../crypto/box';
import { NoteskyOAuth } from './oauth';
import { IndexedDbStore } from './store';
import { ObsidianVaultAdapter } from './vault-adapter';
import { RealPdsClient, login } from './pds-client';
import { NoteskySettingTab } from './settings';
import { SetupWizard } from './setup-wizard';
import { registerPublishCommands } from './publish';

export interface NoteskySettings {
  identifier: string;
  appPassword: string;
  /** 'oauth' after a Sign in with Bluesky; app-password otherwise. */
  authMode: 'app-password' | 'oauth';
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
}

export const DEFAULT_SETTINGS: NoteskySettings = {
  identifier: '',
  appPassword: '',
  authMode: 'app-password',
  authDid: '',
  pdsUrlOverride: '',
  vaultRkey: '',
  masterKeyB64: '',
  syncIntervalMinutes: 5,
  ignorePatterns: [],
};

const DEBOUNCE_MS = 2000;

export type AuthPhase = 'pending' | 'complete' | 'failed';

export default class NoteskyPlugin extends Plugin {
  settings: NoteskySettings = { ...DEFAULT_SETTINGS };
  store!: IndexedDbStore;
  pdsClient: RealPdsClient | null = null;
  oauth = new NoteskyOAuth();
  private authListeners = new Set<(phase: AuthPhase) => void>();

  /**
   * Subscribe to OAuth protocol-handler progress: 'pending' when the browser
   * returns and the token exchange starts, then 'complete' or 'failed'.
   */
  onAuthChanged(listener: (phase: AuthPhase) => void): () => void {
    this.authListeners.add(listener);
    return () => this.authListeners.delete(listener);
  }

  private notifyAuth(phase: AuthPhase): void {
    this.authListeners.forEach((listener) => listener(phase));
  }
  private engine: SyncEngine | null = null;

  /** Files the last sync skipped as too large for the PDS (shown in settings). */
  get skippedPaths(): string[] {
    return this.engine?.lastSkippedPaths ?? [];
  }
  private statusBar!: HTMLElement;
  private syncing = false;
  private lastSyncAt: Date | null = null;
  private debounceTimer: number | null = null;
  private intervalHandle: number | null = null;

  async onload() {
    this.store = new IndexedDbStore(this.app.vault.getName());
    const saved = await this.store.loadSettings();
    this.settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };

    this.statusBar = this.addStatusBarItem();
    this.setStatus('idle');
    this.addSettingTab(new NoteskySettingTab(this.app, this));

    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => void this.runSync(true),
    });
    this.addCommand({
      id: 'setup',
      name: 'Set up sync',
      callback: () => new SetupWizard(this.app, this).open(),
    });
    registerPublishCommands(this);

    this.registerObsidianProtocolHandler('notesky-auth', (params) => {
      void (async () => {
        this.notifyAuth('pending');
        try {
          const session = await this.oauth.completeCallback(params);
          this.settings.authMode = 'oauth';
          this.settings.authDid = session.did;
          // Ready for onboarding (vault record setup) even before the engine can start.
          this.pdsClient = new RealPdsClient(new Agent(session), session.did);
          await this.saveSettings();
          new Notice(`Notesky: signed in as ${session.did}`);
          this.notifyAuth('complete');
          await this.initEngine();
        } catch (err) {
          this.notifyAuth('failed');
          new Notice(`Notesky: sign-in failed — ${err instanceof Error ? err.message : err}`);
        }
      })();
    });

    this.app.workspace.onLayoutReady(() =>
      void (async () => {
        await this.initEngine();
        // Fresh install (no auth, no key): open the guided setup once.
        const s = this.settings;
        if (!s.masterKeyB64 && !s.authDid && !s.appPassword) {
          new SetupWizard(this.app, this).open();
        }
      })()
    );

    this.registerEvent(this.app.vault.on('modify', () => this.scheduleSync()));
    this.registerEvent(this.app.vault.on('create', () => this.scheduleSync()));
    this.registerEvent(this.app.vault.on('delete', () => this.scheduleSync()));
    this.registerEvent(this.app.vault.on('rename', () => this.scheduleSync()));
    this.applySyncInterval();
  }

  onunload() {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    if (this.intervalHandle !== null) window.clearInterval(this.intervalHandle);
  }

  async saveSettings(): Promise<void> {
    await this.store.saveSettings({ ...this.settings });
    this.applySyncInterval();
  }

  /** (Re)build the engine from settings; called on load and after onboarding. */
  async initEngine(): Promise<void> {
    const s = this.settings;
    const hasAuth =
      s.authMode === 'oauth' ? Boolean(s.authDid) : Boolean(s.identifier && s.appPassword);
    if (!hasAuth || !s.masterKeyB64 || !s.vaultRkey) {
      this.setStatus('setup');
      return; // not onboarded yet; settings tab drives setup
    }
    try {
      if (s.authMode === 'oauth') {
        const session = await this.oauth.restore(s.authDid);
        this.pdsClient = new RealPdsClient(new Agent(session), s.authDid);
      } else {
        this.pdsClient = await login({
          identifier: s.identifier,
          password: s.appPassword,
          pdsUrl: s.pdsUrlOverride || undefined,
        });
      }
      let progressNotice: Notice | null = null;
      this.engine = new SyncEngine({
        pds: this.pdsClient,
        vault: new ObsidianVaultAdapter(this.app, () => this.settings.ignorePatterns),
        index: this.store,
        masterKey: await fromB64(s.masterKeyB64),
        vaultRkey: s.vaultRkey,
        interBatchDelayMs: 300,
        onWarning: (msg) => new Notice(`Notesky: ${msg}`, 10_000),
        onProgress: (done, total) => {
          if (total <= 50) return;
          if (!progressNotice) progressNotice = new Notice('', 0);
          progressNotice.setMessage(`Notesky: syncing ${done}/${total}…`);
          if (done >= total) {
            progressNotice.hide();
            progressNotice = null;
          }
        },
      });
      await this.runSync();
    } catch (err) {
      this.engine = null;
      this.setStatus('error');
      new Notice(`Notesky: could not connect — ${err instanceof Error ? err.message : err}`);
    }
  }

  disconnectEngine(): void {
    this.engine = null;
    this.pdsClient = null;
    this.setStatus('idle');
  }

  private scheduleSync(): void {
    if (!this.engine) return;
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => void this.runSync(), DEBOUNCE_MS);
  }

  private applySyncInterval(): void {
    if (this.intervalHandle !== null) window.clearInterval(this.intervalHandle);
    const minutes = Math.max(1, this.settings.syncIntervalMinutes);
    this.intervalHandle = window.setInterval(() => void this.runSync(), minutes * 60_000);
    this.registerInterval(this.intervalHandle);
  }

  async runSync(manual = false): Promise<void> {
    if (!this.engine) {
      // Background syncs stay silent while unconfigured; only a user-initiated
      // sync explains what is missing.
      if (manual) {
        const s = this.settings;
        const hasAuth =
          s.authMode === 'oauth' ? Boolean(s.authDid) : Boolean(s.identifier && s.appPassword);
        if (!hasAuth) {
          new Notice('Notesky: connect your account in settings first.');
        } else if (!s.masterKeyB64 || !s.vaultRkey) {
          new Notice(
            'Notesky: set your encryption passphrase in settings — syncing stays off until then.'
          );
        } else {
          new Notice('Notesky: not connected — check settings.');
        }
      }
      return;
    }
    if (this.syncing) return;
    this.syncing = true;
    this.setStatus('syncing');
    try {
      await this.engine.sync();
      this.lastSyncAt = new Date();
      this.setStatus('idle');
    } catch (err) {
      this.setStatus('error');
      new Notice(`Notesky sync failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.syncing = false;
    }
  }

  private setStatus(state: 'idle' | 'syncing' | 'error' | 'setup'): void {
    const time = this.lastSyncAt
      ? ` · ${this.lastSyncAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';
    const label =
      state === 'syncing'
        ? 'syncing…'
        : state === 'error'
          ? 'error'
          : state === 'setup'
            ? 'setup needed'
            : `synced${time}`;
    this.statusBar.setText(`Notesky: ${label}`);
  }
}
