import { App, Modal, Notice, Setting } from 'obsidian';
import { login } from './pds-client';
import {
  VaultInfo,
  WrongPassphraseError,
  createVault,
  listVaults,
  unlockVault,
} from './onboarding';
import { PASSPHRASE_WARNING } from './settings';
import { createBusyRow, createLinkButton } from './ui';
import type AtprotoSyncPlugin from './main';

type Step = 'login' | 'browser' | 'passphrase' | 'done';

/** Guided first-run setup: sign in → browser handoff → passphrase → syncing. */
export class SetupWizard extends Modal {
  private step: Step = 'login';
  private handle = '';
  private appPassword = '';
  private passphrase = '';
  private useAppPassword = false;
  private busy = false;
  private busyMessage: string | null = null;
  private vaults: VaultInfo[] | null = null;
  private targetVault: VaultInfo | null = null;
  private authUrl: string | null = null;
  private offAuthChanged: (() => void) | null = null;

  constructor(
    app: App,
    private readonly plugin: AtprotoSyncPlugin
  ) {
    super(app);
    this.handle = plugin.settings.identifier;
  }

  onOpen(): void {
    this.contentEl.addClass('atproto-sync-wizard');
    const s = this.plugin.settings;
    const hasAuth = s.authMode === 'oauth' ? Boolean(s.authDid) : Boolean(s.identifier && s.appPassword);
    if (s.masterKeyB64 && s.vaultRkey && hasAuth) this.step = 'done';
    else if (hasAuth) this.step = 'passphrase';
    // OAuth completes out-of-band via the protocol handler; reflect its progress.
    this.offAuthChanged = this.plugin.onAuthChanged((phase) => {
      if (this.step !== 'login' && this.step !== 'browser') return;
      if (phase === 'pending') {
        this.busyMessage = 'Completing sign-in…';
      } else {
        this.busyMessage = null;
        if (phase === 'complete') this.step = 'passphrase';
      }
      this.render();
    });
    this.render();
  }

  onClose(): void {
    this.offAuthChanged?.();
    this.contentEl.empty();
  }

  private stepTitle(): string {
    switch (this.step) {
      case 'login':
        return 'Set up ATProto Sync';
      case 'browser':
        return 'Continue in your browser';
      case 'passphrase':
        if (this.vaults === null) return 'Vault passphrase';
        return this.targetVault ? 'Enter vault passphrase' : 'Create vault passphrase';
      case 'done':
        return 'You’re all set';
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: this.stepTitle() });

    // While work runs the form disappears entirely: just title + spinner.
    if (this.busyMessage) {
      createBusyRow(contentEl, this.busyMessage);
      return;
    }

    if (this.step === 'login') this.renderLogin();
    else if (this.step === 'browser') this.renderBrowser();
    else if (this.step === 'passphrase') this.renderPassphrase();
    else this.renderDone();
  }

  /** Run an async transition with a spinner shown and inputs disabled. */
  private async withBusy(message: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.busyMessage = message;
    this.render();
    try {
      await fn();
    } finally {
      this.busy = false;
      this.busyMessage = null;
      this.render();
    }
  }

  // ── Step 1: sign in ──────────────────────────────────────────────────────
  private renderLogin(): void {
    const { contentEl } = this;
    contentEl.createEl('p', {
      text: 'Sign in with the account your vault will sync to.',
    });

    new Setting(contentEl)
      .setName('Handle')
      .setDesc('e.g. you.bsky.social')
      .addText((t) =>
        t.setValue(this.handle).onChange((v) => (this.handle = v.trim()))
      );

    if (!this.useAppPassword) {
      new Setting(contentEl).addButton((b) =>
        b
          .setButtonText('Sign in with Bluesky')
          .setCta()
          .onClick(() => void this.startOAuth())
      );
      const alt = contentEl.createEl('p');
      const link = alt.createEl('a', { text: 'Use an app password instead' });
      link.addEventListener('click', () => {
        this.useAppPassword = true;
        this.render();
      });
    } else {
      new Setting(contentEl)
        .setName('App password')
        .setDesc('Create one in your PDS account settings — not your main password.')
        .addText((t) => {
          t.inputEl.type = 'password';
          t.setValue(this.appPassword).onChange((v) => (this.appPassword = v.trim()));
        });
      new Setting(contentEl)
        .addButton((b) =>
          b
            .setButtonText('Log in')
            .setCta()
            .onClick(() => void this.loginWithAppPassword())
        )
        .addButton((b) =>
          b.setButtonText('Back').onClick(() => {
            this.useAppPassword = false;
            this.render();
          })
        );
    }
  }

  private async startOAuth(): Promise<void> {
    if (!this.handle) {
      new Notice('ATProto Sync: enter your handle first.');
      return;
    }
    await this.withBusy('Contacting your server…', async () => {
      try {
        this.plugin.settings.identifier = this.handle;
        await this.plugin.saveSettings();
        this.authUrl = await this.plugin.oauth.createAuthUrl(this.handle);
        this.step = 'browser';
      } catch (err) {
        new Notice(`ATProto Sync: sign-in failed — ${err instanceof Error ? err.message : err}`);
      }
    });
  }

  // ── Step 2: browser handoff ──────────────────────────────────────────────
  private renderBrowser(): void {
    const { contentEl } = this;
    contentEl.createEl('p', {
      text: `Your sign-in for ${this.handle} is ready. Approve it in the browser and Obsidian will pick up right here.`,
    });

    // A real anchor: Obsidian routes it to the system browser on all platforms.
    createLinkButton(contentEl, this.authUrl!, 'Open login page');

    const back = contentEl.createEl('p');
    const backLink = back.createEl('a', { text: 'Back' });
    backLink.addEventListener('click', () => {
      this.step = 'login';
      this.render();
    });
  }

  private async loginWithAppPassword(): Promise<void> {
    if (!this.handle || !this.appPassword) {
      new Notice('ATProto Sync: enter your handle and app password.');
      return;
    }
    await this.withBusy('Signing in…', async () => {
      try {
        const s = this.plugin.settings;
        this.plugin.pdsClient = await login({
          identifier: this.handle,
          password: this.appPassword,
          pdsUrl: s.pdsUrlOverride || undefined,
        });
        s.identifier = this.handle;
        s.appPassword = this.appPassword;
        s.authMode = 'app-password';
        await this.plugin.saveSettings();
        this.step = 'passphrase';
      } catch (err) {
        new Notice(`ATProto Sync: login failed — ${err instanceof Error ? err.message : err}`);
      }
    });
  }

  // ── Step 2: passphrase ───────────────────────────────────────────────────
  private renderPassphrase(): void {
    const { contentEl } = this;

    if (this.vaults === null) {
      createBusyRow(contentEl, 'Checking your account…');
      void listVaults(this.plugin)
        .then((vaults) => {
          this.vaults = vaults;
          // Folder name is the vault identity: bind to the match by default.
          this.targetVault =
            vaults.find((v) => v.name === this.plugin.app.vault.getName()) ?? null;
          this.render();
        })
        .catch((err) => {
          new Notice(`ATProto Sync: ${err instanceof Error ? err.message : err}`);
        });
      return;
    }

    const folderName = this.plugin.app.vault.getName();
    if (this.targetVault) {
      contentEl.createEl('p', {
        text: `Your vault data is encrypted whenever it leaves your device. Enter the passphrase you chose when you first set up “${this.targetVault.name}”.`,
      });
    } else {
      contentEl.createEl('p', {
        text: `Your vault data is encrypted whenever it leaves your device. Choose the passphrase that will protect “${folderName}”.`,
      });
      contentEl.createEl('p', { text: PASSPHRASE_WARNING, cls: 'mod-warning' });
    }

    new Setting(contentEl).setName('Passphrase').addText((t) => {
      t.inputEl.type = 'password';
      t.setValue(this.passphrase).onChange((v) => (this.passphrase = v));
      t.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void this.submitPassphrase();
      });
    });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(this.targetVault ? 'Unlock vault' : 'Create vault')
        .setCta()
        .onClick(() => void this.submitPassphrase())
    );
  }

  private async submitPassphrase(): Promise<void> {
    if (!this.passphrase) {
      new Notice('ATProto Sync: enter a passphrase.');
      return;
    }
    const target = this.targetVault;
    await this.withBusy(target ? 'Unlocking your vault…' : 'Creating your vault…', async () => {
      try {
        if (target) {
          await unlockVault(this.plugin, target.rkey, this.passphrase);
        } else {
          await createVault(this.plugin, this.plugin.app.vault.getName(), this.passphrase);
        }
        this.step = 'done';
        await this.plugin.initEngine();
      } catch (err) {
        if (err instanceof WrongPassphraseError) {
          new Notice('ATProto Sync: wrong passphrase for this vault — try again.');
        } else {
          new Notice(`ATProto Sync: ${err instanceof Error ? err.message : err}`);
        }
      }
    });
  }

  // ── Step 3: done ─────────────────────────────────────────────────────────
  private renderDone(): void {
    const { contentEl } = this;
    contentEl.createEl('p', {
      text: 'ATProto Sync is syncing this vault, end-to-end encrypted. The status bar shows sync state; everything else lives in Settings → ATProto Sync.',
    });
    new Setting(contentEl).addButton((b) =>
      b.setButtonText('Done').setCta().onClick(() => this.close())
    );
  }
}
