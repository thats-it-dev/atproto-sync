import { Notice, Plugin } from 'obsidian';
import { Agent } from '@atproto/api';
import { SyncEngine } from '@atproto-sync/core/sync/engine';
import { fromB64 } from '@atproto-sync/core/crypto/box';
import { AtprotoOAuth } from './oauth';
import { IndexedDbStore } from './store';
import { ObsidianVaultAdapter } from './vault-adapter';
import { RealPdsClient } from '@atproto-sync/core/atproto/pds-client';
import { login } from './login';
import { setIconWithFallback } from './ui';
import { AtprotoSyncSettingTab } from './settings';
import { SetupWizard } from './setup-wizard';
import { registerPublishCommands } from './publish';
import { AtprotoSyncSettings, DEFAULT_SETTINGS, hasAuth, resolveSettings } from './auth-settings';

export type { AtprotoSyncSettings } from './auth-settings';

const DEBOUNCE_MS = 2000;

export type AuthPhase = 'pending' | 'complete' | 'failed';

export default class AtprotoSyncPlugin extends Plugin {
  settings: AtprotoSyncSettings = { ...DEFAULT_SETTINGS };
  store!: IndexedDbStore;
  pdsClient: RealPdsClient | null = null;
  oauth = new AtprotoOAuth();
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

  /** The open setup wizard, if any — so auth callbacks don't open a second one. */
  activeWizard: SetupWizard | null = null;

  /**
   * Roll back a half-finished setup: auth without a passphrase must not
   * persist, or the user believes syncing works when nothing ever leaves
   * the device.
   */
  async wipeAuth(): Promise<void> {
    this.settings.setupIncomplete = true;
    await this.signOut();
  }

  /**
   * Revoke the OAuth session (if any) and clear stored credentials. The chosen
   * sign-in method is kept, so the user signs back in the same way.
   */
  async signOut(): Promise<void> {
    const s = this.settings;
    if (s.authDid) await this.oauth.logout(s.authDid).catch(() => {});
    s.appPassword = '';
    s.authDid = '';
    await this.saveSettings();
    this.disconnectEngine();
  }
  private engine: SyncEngine | null = null;
  private vaultAdapter: ObsidianVaultAdapter | null = null;

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
    this.settings = resolveSettings(saved as Partial<AtprotoSyncSettings> | null);

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass('mod-clickable', 'atproto-sync-status');
    this.statusBar.addEventListener('click', () => {
      if (this.currentStatus === 'setup') new SetupWizard(this.app, this).open();
      else void this.runSync(true);
    });
    this.setStatus('idle');
    this.addSettingTab(new AtprotoSyncSettingTab(this.app, this));

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

    this.registerObsidianProtocolHandler('atproto-sync-auth', (params) => {
      void (async () => {
        this.notifyAuth('pending');
        try {
          const session = await this.oauth.completeCallback(params);
          this.settings.authMode = 'oauth';
          this.settings.authDid = session.did;
          this.settings.appPassword = '';
          // Ready for onboarding (vault record setup) even before the engine can start.
          this.pdsClient = new RealPdsClient(new Agent(session), session.did);
          await this.saveSettings();
          new Notice(`ATProto Sync: signed in as ${session.did}`);
          this.notifyAuth('complete');
          if (!this.settings.masterKeyB64 || !this.settings.vaultRkey) {
            // Setup isn't done until the passphrase exists: put the wizard
            // (at its passphrase step) in front of the user. The Settings
            // dialog outranks modals in z-order, so close it first or the
            // wizard opens invisibly behind it.
            (this.app as unknown as { setting?: { close?: () => void } }).setting?.close?.();
            if (!this.activeWizard) new SetupWizard(this.app, this).open();
          } else {
            await this.initEngine();
          }
        } catch (err) {
          this.notifyAuth('failed');
          new Notice(`ATProto Sync: sign-in failed — ${err instanceof Error ? err.message : err}`);
        }
      })();
    });

    this.app.workspace.onLayoutReady(() =>
      void (async () => {
        const s = this.settings;
        if (hasAuth(s) && (!s.masterKeyB64 || !s.vaultRkey)) {
          // A half-finished setup survived a restart: roll it back.
          await this.wipeAuth();
          new Notice(
            'ATProto Sync: setup was never finished, so you were signed out. Nothing has synced.'
          );
          return;
        }
        await this.initEngine();
        // Fresh install (no auth, no key): open the guided setup once.
        if (!s.masterKeyB64 && !s.authDid && !s.appPassword && !s.setupIncomplete) {
          new SetupWizard(this.app, this).open();
        }
      })()
    );

    this.registerEvent(this.app.vault.on('modify', () => this.scheduleSync()));
    this.registerEvent(this.app.vault.on('create', () => this.scheduleSync()));
    this.registerEvent(this.app.vault.on('delete', () => this.scheduleSync()));
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        // Hand the move to the engine so the record keeps its rkey instead of
        // being deleted at the old path and recreated at the new one.
        this.vaultAdapter?.noteRename(oldPath, file.path);
        this.scheduleSync();
      })
    );
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
    if (!hasAuth(s) || !s.masterKeyB64 || !s.vaultRkey) {
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
      this.vaultAdapter = new ObsidianVaultAdapter(this.app, () => this.settings.ignorePatterns);
      this.engine = new SyncEngine({
        pds: this.pdsClient,
        vault: this.vaultAdapter,
        index: this.store,
        masterKey: await fromB64(s.masterKeyB64),
        vaultRkey: s.vaultRkey,
        interBatchDelayMs: 300,
        onWarning: (msg) => new Notice(`ATProto Sync: ${msg}`, 10_000),
        onProgress: (done, total) => {
          if (total <= 50) return;
          if (!progressNotice) progressNotice = new Notice('', 0);
          progressNotice.setMessage(`ATProto Sync: syncing ${done}/${total}…`);
          if (done >= total) {
            progressNotice.hide();
            progressNotice = null;
          }
        },
      });
      await this.runSync();
    } catch (err) {
      this.engine = null;
      this.vaultAdapter = null;
      this.setStatus('error');
      new Notice(`ATProto Sync: could not connect — ${err instanceof Error ? err.message : err}`);
    }
  }

  disconnectEngine(): void {
    this.engine = null;
    this.vaultAdapter = null;
    this.pdsClient = null;
    this.setStatus('setup');
  }

  /** Danger-zone disconnect: revoke the session and forget everything device-local. */
  async disconnectAccount(): Promise<void> {
    const s = this.settings;
    s.identifier = '';
    s.masterKeyB64 = '';
    s.vaultRkey = '';
    s.setupIncomplete = false;
    await this.signOut();
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
        if (!hasAuth(s)) {
          new Notice('ATProto Sync: connect your account in settings first.');
        } else if (!s.masterKeyB64 || !s.vaultRkey) {
          new Notice(
            'ATProto Sync: set your encryption passphrase in settings — syncing stays off until then.'
          );
        } else {
          new Notice('ATProto Sync: not connected — check settings.');
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
      new Notice(`ATProto Sync failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.syncing = false;
    }
  }

  private currentStatus: 'idle' | 'syncing' | 'error' | 'setup' = 'idle';

  private setStatus(state: 'idle' | 'syncing' | 'error' | 'setup'): void {
    this.currentStatus = state;
    const time = this.lastSyncAt
      ? ` · ${this.lastSyncAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';
    const incomplete = state === 'setup' && this.settings.setupIncomplete;
    const config = {
      idle: { icon: 'cloud-check', fallback: 'cloud', tip: `ATProto Sync: synced${time} — click to sync now` },
      syncing: { icon: 'cloud-sync', fallback: 'refresh-cw', tip: 'ATProto Sync: syncing…' },
      error: { icon: 'cloud-alert', fallback: 'cloud-off', tip: 'ATProto Sync: sync error — click to retry' },
      setup: incomplete
        ? { icon: 'cloud-alert', fallback: 'cloud-off', tip: 'ATProto Sync: setup incomplete — click to finish' }
        : { icon: 'cloud-off', fallback: 'cloud-off', tip: 'ATProto Sync: setup needed — click to begin' },
    }[state];
    setIconWithFallback(this.statusBar, config.icon, config.fallback);
    this.statusBar.setAttr('aria-label', config.tip);
    this.statusBar.setAttr('data-sync-status', incomplete ? 'attention' : state);
  }
}
