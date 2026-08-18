import { App, Modal, Notice, Platform, PluginSettingTab, Setting } from 'obsidian';
import { login } from './pds-client';
import { WrongPassphraseError, setupVaultEncryption } from './onboarding';
import { SetupWizard } from './setup-wizard';
import { createLinkButton } from './ui';
import type AtprotoSyncPlugin from './main';

/** Mobile sign-in: the user must tap the link themselves for Safari/Chrome to open. */
class OpenBrowserModal extends Modal {
  constructor(
    app: App,
    private readonly url: string
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Continue in your browser' });
    contentEl.createEl('p', {
      text: 'Tap below to open your PDS login page. Obsidian will reopen automatically once you approve.',
    });
    const link = createLinkButton(contentEl, this.url, 'Open login page');
    link.addEventListener('click', () => this.close());
    new Setting(contentEl).addButton((b) =>
      b.setButtonText('Copy link instead').onClick(async () => {
        await navigator.clipboard.writeText(this.url);
        new Notice('ATProto Sync: link copied — paste it into your browser.');
      })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export const PASSPHRASE_WARNING =
  'If you lose this passphrase, encrypted notes on the server cannot be recovered by anyone — including us.';

export class AtprotoSyncSettingTab extends PluginSettingTab {
  private passphrase = '';

  constructor(
    app: App,
    private readonly plugin: AtprotoSyncPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    if (!s.masterKeyB64 || !s.vaultRkey) {
      new Setting(containerEl)
        .setName('Guided setup')
        .setDesc('Sign in and set your passphrase in two steps.')
        .addButton((b) =>
          b
            .setButtonText('Start setup')
            .setCta()
            .onClick(() => {
              new SetupWizard(this.app, this.plugin).open();
            })
        );
    }

    // ── Account ────────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Account').setHeading();

    new Setting(containerEl)
      .setName('Handle')
      .setDesc('Your ATProto handle, e.g. you.bsky.social')
      .addText((t) =>
        t.setValue(s.identifier).onChange(async (v) => {
          s.identifier = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Sign in with Bluesky')
      .setDesc(
        s.authMode === 'oauth' && s.authDid
          ? `Signed in via OAuth as ${s.authDid}`
          : 'Opens your PDS login page in the browser — no app password needed.'
      )
      .addButton((b) =>
        b
          .setButtonText('Sign in')
          .setCta()
          .onClick(async () => {
            if (!s.identifier) {
              new Notice('ATProto Sync: enter your handle first.');
              return;
            }
            try {
              const url = await this.plugin.oauth.createAuthUrl(s.identifier);
              if (Platform.isMobileApp) {
                // Mobile WebViews ignore programmatic window.open; a real tap
                // on a real anchor rides Obsidian's external-link handling.
                new OpenBrowserModal(this.app, url).open();
              } else {
                window.open(url);
                new Notice('ATProto Sync: continue in your browser; Obsidian will reopen when done.');
              }
            } catch (err) {
              new Notice(`ATProto Sync: sign-in failed — ${err instanceof Error ? err.message : err}`);
            }
          })
      );

    new Setting(containerEl).setName('Log out').addButton((b) =>
      b.setButtonText('Log out').onClick(async () => {
        if (s.authMode === 'oauth' && s.authDid) {
          await this.plugin.oauth.logout(s.authDid).catch(() => {});
        }
        s.appPassword = '';
        s.authDid = '';
        s.authMode = 'app-password';
        await this.plugin.saveSettings();
        this.plugin.disconnectEngine();
        this.display();
      })
    );

    // ── Encryption ─────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Encryption').setHeading();
    if (!s.masterKeyB64) {
      containerEl.createEl('p', {
        text: 'Syncing stays off until you set a passphrase — nothing leaves this device unencrypted.',
      });
    }
    containerEl.createEl('p', {
      text: PASSPHRASE_WARNING,
      cls: 'mod-warning',
    });

    new Setting(containerEl)
      .setName('Vault passphrase')
      .setDesc(
        s.masterKeyB64
          ? 'Encryption is set up on this device.'
          : 'First device: sets up encryption. Later devices: enter the same passphrase.'
      )
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('passphrase').onChange((v) => (this.passphrase = v));
      })
      .addButton((b) =>
        b
          .setButtonText(s.masterKeyB64 ? 'Re-enter' : 'Set up')
          .setCta()
          .onClick(() => void this.setupEncryption())
      );

    // ── Sync ───────────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Sync').setHeading();

    new Setting(containerEl)
      .setName('Sync interval (minutes)')
      .addText((t) =>
        t.setValue(String(s.syncIntervalMinutes)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1) {
            s.syncIntervalMinutes = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName('Ignore patterns')
      .setDesc('One per line. Folders, exact paths, or globs (drafts/**, **/tmp-*.md).')
      .addTextArea((t) =>
        t.setValue(s.ignorePatterns.join('\n')).onChange(async (v) => {
          s.ignorePatterns = v
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
          await this.plugin.saveSettings();
        })
      );

    // ── Advanced ───────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Advanced').setHeading();

    new Setting(containerEl)
      .setName('App password')
      .setDesc('Fallback if Sign in with Bluesky is unavailable. Create one in your PDS account settings — not your main password.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setValue(s.appPassword).onChange(async (v) => {
          s.appPassword = v.trim();
          await this.plugin.saveSettings();
        });
      })
      .addButton((b) =>
        b.setButtonText('Test login').onClick(async () => {
          try {
            this.plugin.pdsClient = await login({
              identifier: s.identifier,
              password: s.appPassword,
              pdsUrl: s.pdsUrlOverride || undefined,
            });
            new Notice('ATProto Sync: login OK');
          } catch (err) {
            new Notice(`ATProto Sync: login failed — ${err instanceof Error ? err.message : err}`);
          }
        })
      );

    new Setting(containerEl)
      .setName('PDS URL')
      .setDesc('Leave empty to auto-detect from your handle. Set for self-hosted or local testing, e.g. http://localhost:3000.')
      .addText((t) =>
        t.setPlaceholder('auto').setValue(s.pdsUrlOverride).onChange(async (v) => {
          s.pdsUrlOverride = v.trim();
          await this.plugin.saveSettings();
        })
      );

    const skipped = this.plugin.skippedPaths;
    if (skipped.length > 0) {
      new Setting(containerEl).setName('Skipped files').setHeading();
      containerEl.createEl('p', {
        text: 'Too large for your PDS to store — these stay on this device only:',
      });
      const list = containerEl.createEl('ul');
      for (const path of skipped) list.createEl('li', { text: path });
    }

    // ── Danger zone ────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Danger zone').setHeading();

    new Setting(containerEl)
      .setName('Full re-scan')
      .setDesc('Forget local sync state and reconcile everything from scratch. Safe, but slow.')
      .addButton((b) =>
        b.setButtonText('Re-scan').setWarning().onClick(async () => {
          await this.plugin.store.save([]);
          new Notice('ATProto Sync: sync state cleared; next sync re-scans everything.');
          await this.plugin.runSync(true);
        })
      );

    new Setting(containerEl)
      .setName('Disconnect')
      .setDesc('Remove credentials and cached keys from this device. Notes stay on the PDS.')
      .addButton((b) =>
        b.setButtonText('Disconnect').setWarning().onClick(async () => {
          await this.plugin.disconnectAccount();
          new Notice('ATProto Sync: disconnected. Credentials and keys removed from this device.');
          this.display();
        })
      );
  }

  /** First device creates the vault record; later devices verify against it. */
  private async setupEncryption(): Promise<void> {
    if (!this.passphrase) {
      new Notice('ATProto Sync: enter a passphrase first.');
      return;
    }
    try {
      const result = await setupVaultEncryption(this.plugin, this.passphrase);
      new Notice(
        result === 'created'
          ? 'ATProto Sync: encryption set up. This vault is now syncing.'
          : 'ATProto Sync: passphrase verified. This device is now syncing.'
      );
    } catch (err) {
      if (err instanceof WrongPassphraseError) {
        new Notice('ATProto Sync: wrong passphrase for this vault.');
      } else {
        new Notice(`ATProto Sync: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }
    this.passphrase = '';
    await this.plugin.initEngine();
    this.display();
  }
}
