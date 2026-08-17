import { Notice, Plugin } from 'obsidian';
import { SyncEngine } from '../sync/engine';
import { fromB64 } from '../crypto/box';
import { IndexedDbStore } from './store';
import { ObsidianVaultAdapter } from './vault-adapter';
import { RealPdsClient, login } from './pds-client';
import { NoteskySettingTab } from './settings';
import { registerPublishCommands } from './publish';

export interface NoteskySettings {
  identifier: string;
  appPassword: string;
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
  pdsUrlOverride: '',
  vaultRkey: '',
  masterKeyB64: '',
  syncIntervalMinutes: 5,
  ignorePatterns: [],
};

const DEBOUNCE_MS = 2000;

export default class NoteskyPlugin extends Plugin {
  settings: NoteskySettings = { ...DEFAULT_SETTINGS };
  store!: IndexedDbStore;
  pdsClient: RealPdsClient | null = null;
  private engine: SyncEngine | null = null;
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
      callback: () => void this.runSync(),
    });
    registerPublishCommands(this);

    this.app.workspace.onLayoutReady(() => void this.initEngine());

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
    if (!s.identifier || !s.appPassword || !s.masterKeyB64 || !s.vaultRkey) {
      return; // not onboarded yet; settings tab drives setup
    }
    try {
      this.pdsClient = await login({
        identifier: s.identifier,
        password: s.appPassword,
        pdsUrl: s.pdsUrlOverride || undefined,
      });
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

  async runSync(): Promise<void> {
    if (!this.engine) {
      new Notice('Notesky: not configured yet — open settings to connect.');
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

  private setStatus(state: 'idle' | 'syncing' | 'error'): void {
    const time = this.lastSyncAt
      ? ` · ${this.lastSyncAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';
    const label = state === 'syncing' ? 'syncing…' : state === 'error' ? 'error' : `synced${time}`;
    this.statusBar.setText(`Notesky: ${label}`);
  }
}
