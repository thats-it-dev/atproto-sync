import { App, Modal, Notice, Platform, Setting } from 'obsidian';
import { login } from './pds-client';
import { WrongPassphraseError, setupVaultEncryption, vaultRecordExists } from './onboarding';
import { PASSPHRASE_WARNING } from './settings';
import type NoteskyPlugin from './main';

type Step = 'login' | 'passphrase' | 'done';

/** Guided first-run setup: sign in → passphrase → syncing. */
export class SetupWizard extends Modal {
  private step: Step = 'login';
  private handle = '';
  private appPassword = '';
  private passphrase = '';
  private useAppPassword = false;
  private busy = false;
  private laterDevice: boolean | null = null;
  private offAuthChanged: (() => void) | null = null;

  constructor(
    app: App,
    private readonly plugin: NoteskyPlugin
  ) {
    super(app);
    this.handle = plugin.settings.identifier;
  }

  onOpen(): void {
    const s = this.plugin.settings;
    const hasAuth = s.authMode === 'oauth' ? Boolean(s.authDid) : Boolean(s.identifier && s.appPassword);
    if (s.masterKeyB64 && s.vaultRkey && hasAuth) this.step = 'done';
    else if (hasAuth) this.step = 'passphrase';
    // OAuth completes out-of-band via the protocol handler; advance when it does.
    this.offAuthChanged = this.plugin.onAuthChanged(() => {
      if (this.step === 'login') {
        this.step = 'passphrase';
        this.render();
      }
    });
    this.render();
  }

  onClose(): void {
    this.offAuthChanged?.();
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (this.step === 'login') this.renderLogin();
    else if (this.step === 'passphrase') this.renderPassphrase();
    else this.renderDone();
  }

  // ── Step 1: sign in ──────────────────────────────────────────────────────
  private renderLogin(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Set up Notesky Sync (1/2)' });
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
      new Notice('Notesky: enter your handle first.');
      return;
    }
    this.plugin.settings.identifier = this.handle;
    await this.plugin.saveSettings();
    try {
      const url = await this.plugin.oauth.createAuthUrl(this.handle);
      const { contentEl } = this;
      if (Platform.isMobileApp) {
        // A real tap on a real anchor is required for the browser to open.
        const p = contentEl.createEl('p');
        const link = p.createEl('a', { text: 'Tap to open your login page', href: url });
        link.setAttr('target', '_blank');
        link.setAttr('rel', 'noopener');
        link.style.fontSize = '1.1em';
      } else {
        window.open(url);
        contentEl.createEl('p', { text: 'Continue in your browser — this window will advance automatically.' });
      }
    } catch (err) {
      new Notice(`Notesky: sign-in failed — ${err instanceof Error ? err.message : err}`);
    }
  }

  private async loginWithAppPassword(): Promise<void> {
    if (!this.handle || !this.appPassword) {
      new Notice('Notesky: enter your handle and app password.');
      return;
    }
    if (this.busy) return;
    this.busy = true;
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
      this.render();
    } catch (err) {
      new Notice(`Notesky: login failed — ${err instanceof Error ? err.message : err}`);
    } finally {
      this.busy = false;
    }
  }

  // ── Step 2: passphrase ───────────────────────────────────────────────────
  private renderPassphrase(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Encryption passphrase (2/2)' });
    const intro = contentEl.createEl('p', { text: 'Checking your account…' });

    if (this.laterDevice === null) {
      void vaultRecordExists(this.plugin)
        .then((exists) => {
          this.laterDevice = exists;
          this.render();
        })
        .catch((err) => {
          new Notice(`Notesky: ${err instanceof Error ? err.message : err}`);
        });
      return;
    }
    intro.setText(
      this.laterDevice
        ? 'This account already has an encrypted vault. Enter the same passphrase you chose on your first device.'
        : 'Choose a passphrase. Every note is encrypted with it before it leaves this device.'
    );
    if (!this.laterDevice) {
      contentEl.createEl('p', { text: PASSPHRASE_WARNING, cls: 'mod-warning' });
    }

    new Setting(contentEl).setName('Passphrase').addText((t) => {
      t.inputEl.type = 'password';
      t.onChange((v) => (this.passphrase = v));
      t.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void this.submitPassphrase();
      });
    });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(this.laterDevice ? 'Unlock vault' : 'Create vault')
        .setCta()
        .onClick(() => void this.submitPassphrase())
    );
  }

  private async submitPassphrase(): Promise<void> {
    if (!this.passphrase) {
      new Notice('Notesky: enter a passphrase.');
      return;
    }
    if (this.busy) return;
    this.busy = true;
    try {
      await setupVaultEncryption(this.plugin, this.passphrase);
      this.step = 'done';
      this.render();
      await this.plugin.initEngine();
    } catch (err) {
      if (err instanceof WrongPassphraseError) {
        new Notice('Notesky: wrong passphrase for this vault — try again.');
      } else {
        new Notice(`Notesky: ${err instanceof Error ? err.message : err}`);
      }
    } finally {
      this.busy = false;
    }
  }

  // ── Step 3: done ─────────────────────────────────────────────────────────
  private renderDone(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'You’re all set' });
    contentEl.createEl('p', {
      text: 'Notesky is syncing this vault, end-to-end encrypted. The status bar shows sync state; everything else lives in Settings → Notesky Sync.',
    });
    new Setting(contentEl).addButton((b) =>
      b.setButtonText('Done').setCta().onClick(() => this.close())
    );
  }
}
