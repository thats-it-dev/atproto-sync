import {
  App,
  Modal,
  Notice,
  Platform,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
} from 'obsidian';
import { login } from './login';
import { WrongPassphraseError, setupVaultEncryption } from './onboarding';
import { SetupWizard } from './setup-wizard';
import { createLinkButton } from './ui';
import type AtprotoSyncPlugin from './main';
import { AuthMode, hasAuth } from './auth-settings';

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
  private appPassword = '';

  constructor(
    app: App,
    private readonly plugin: AtprotoSyncPlugin
  ) {
    super(app, plugin);
  }

  getControlValue(key: string): unknown {
    const s = this.plugin.settings;
    if (key === 'ignorePatterns') return s.ignorePatterns.join('\n');
    return (s as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    if (key === 'ignorePatterns') {
      s.ignorePatterns = String(value)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    } else {
      s[key] = typeof value === 'string' ? value.trim() : value;
    }
    await this.plugin.saveSettings();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const plugin = this.plugin;
    const configured = () => Boolean(plugin.settings.masterKeyB64 && plugin.settings.vaultRkey);

    return [
      {
        name: 'Guided setup',
        desc: 'Sign in and set your passphrase in two steps.',
        visible: () => !configured(),
        action: () => new SetupWizard(this.app, plugin).open(),
      },
      {
        type: 'group',
        heading: 'Account',
        items: [
          {
            name: 'Handle',
            desc: 'Your ATProto handle, e.g. you.bsky.social',
            control: { type: 'text', key: 'identifier', defaultValue: '' },
          },
          {
            name: 'Sign-in method',
            desc: 'Sign in with Bluesky opens your PDS login page in the browser. An app password is created in your PDS account settings — not your main password.',
            aliases: ['oauth', 'login', 'app password'],
            render: (setting: Setting) => {
              setting.addDropdown((d) =>
                d
                  .addOption('oauth', 'Sign in with Bluesky')
                  .addOption('app-password', 'App password')
                  .setValue(plugin.settings.authMode)
                  .onChange(async (v) => {
                    // Never leave one method's credentials live under the other.
                    await plugin.signOut();
                    plugin.settings.authMode = v as AuthMode;
                    await plugin.saveSettings();
                    this.update();
                  })
              );
            },
          },
          {
            name: 'Sign in with Bluesky',
            visible: () => plugin.settings.authMode === 'oauth',
            render: (setting: Setting) => {
              const s = plugin.settings;
              setting
                .setDesc(s.authDid ? `Signed in as ${s.authDid}` : 'Not signed in.')
                .addButton((b) =>
                  b
                    .setButtonText(s.authDid ? 'Sign in again' : 'Sign in')
                    .setCta()
                    .onClick(() => void this.startSignIn())
                );
            },
          },
          {
            name: 'App password',
            visible: () => plugin.settings.authMode === 'app-password',
            render: (setting: Setting) => {
              const s = plugin.settings;
              setting
                .setDesc(s.appPassword ? `Signed in as ${s.identifier}` : 'Not signed in.')
                .addText((t) => {
                  t.inputEl.type = 'password';
                  t.setPlaceholder('xxxx-xxxx-xxxx-xxxx').onChange((v) => (this.appPassword = v.trim()));
                })
                .addButton((b) =>
                  b
                    .setButtonText('Log in')
                    .setCta()
                    .onClick(() => void this.loginWithAppPassword())
                );
            },
          },
          {
            name: 'Log out',
            visible: () => hasAuth(plugin.settings),
            render: (setting: Setting) => {
              setting.addButton((b) =>
                b.setButtonText('Log out').onClick(async () => {
                  await plugin.signOut();
                  this.update();
                })
              );
            },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Encryption',
        items: [
          {
            name: 'Syncing stays off until you set a passphrase — nothing leaves this device unencrypted.',
            visible: () => !plugin.settings.masterKeyB64,
            searchable: false,
          },
          {
            name: PASSPHRASE_WARNING,
            searchable: false,
          },
          {
            name: 'Vault passphrase',
            aliases: ['encryption', 'password'],
            render: (setting: Setting) => {
              const configured = Boolean(plugin.settings.masterKeyB64);
              setting
                .setDesc(
                  configured
                    ? 'Encryption is set up on this device.'
                    : 'First device: sets up encryption. Later devices: enter the same passphrase.'
                )
                .addText((t) => {
                  t.inputEl.type = 'password';
                  t.setPlaceholder('passphrase').onChange((v) => (this.passphrase = v));
                })
                .addButton((b) =>
                  b
                    .setButtonText(configured ? 'Re-enter' : 'Set up')
                    .setCta()
                    .onClick(() => void this.setupEncryption())
                );
            },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Sync',
        items: [
          {
            name: 'Sync interval (minutes)',
            control: { type: 'number', key: 'syncIntervalMinutes', defaultValue: 5, min: 1 },
          },
          {
            name: 'Ignore patterns',
            desc: 'One per line. Folders, exact paths, or globs (drafts/**, **/tmp-*.md).',
            control: { type: 'textarea', key: 'ignorePatterns' },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Advanced',
        items: [
          {
            name: 'PDS URL',
            desc: 'Leave empty to auto-detect from your handle. Set for self-hosted or local testing, e.g. http://localhost:3000.',
            control: { type: 'text', key: 'pdsUrlOverride', defaultValue: '' },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Skipped files',
        visible: () => this.plugin.skippedPaths.length > 0,
        items: [
          {
            name: 'Too large for your PDS to store — these stay on this device only.',
            searchable: false,
            render: (setting: Setting) => {
              const list = setting.descEl.createEl('ul');
              for (const path of this.plugin.skippedPaths) list.createEl('li', { text: path });
            },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Danger zone',
        items: [
          {
            name: 'Full re-scan',
            desc: 'Forget local sync state and reconcile everything from scratch. Safe, but slow.',
            render: (setting: Setting) => {
              setting.addButton((b) =>
                b.setButtonText('Re-scan').setDestructive().onClick(async () => {
                  await plugin.store.save([]);
                  new Notice('ATProto Sync: sync state cleared; next sync re-scans everything.');
                  await plugin.runSync(true);
                })
              );
            },
          },
          {
            name: 'Disconnect',
            desc: 'Remove credentials and cached keys from this device. Notes stay on the PDS.',
            render: (setting: Setting) => {
              setting.addButton((b) =>
                b.setButtonText('Disconnect').setDestructive().onClick(async () => {
                  await plugin.disconnectAccount();
                  new Notice('ATProto Sync: disconnected. Credentials and keys removed from this device.');
                  this.update();
                })
              );
            },
          },
        ],
      },
    ];
  }

  private async startSignIn(): Promise<void> {
    const s = this.plugin.settings;
    if (!s.identifier) {
      new Notice('ATProto Sync: enter your handle first.');
      return;
    }
    try {
      const url = await this.plugin.oauth.createAuthUrl(s.identifier);
      if (Platform.isMobileApp) {
        // Mobile WebViews ignore programmatic window.open; a real tap on a
        // real anchor rides Obsidian's external-link handling.
        new OpenBrowserModal(this.app, url).open();
      } else {
        window.open(url);
        new Notice('ATProto Sync: continue in your browser; Obsidian will reopen when done.');
      }
    } catch (err) {
      new Notice(`ATProto Sync: sign-in failed — ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Log in with the typed app password; only a successful login replaces the stored one. */
  private async loginWithAppPassword(): Promise<void> {
    const s = this.plugin.settings;
    if (!s.identifier || !this.appPassword) {
      new Notice('ATProto Sync: enter your handle and app password.');
      return;
    }
    try {
      const client = await login({
        identifier: s.identifier,
        password: this.appPassword,
        pdsUrl: s.pdsUrlOverride || undefined,
      });
      await this.plugin.signOut();
      s.authMode = 'app-password';
      s.appPassword = this.appPassword;
      this.appPassword = '';
      this.plugin.pdsClient = client;
      await this.plugin.saveSettings();
      new Notice('ATProto Sync: logged in.');
      await this.plugin.initEngine();
    } catch (err) {
      new Notice(`ATProto Sync: login failed — ${err instanceof Error ? err.message : err}`);
    }
    this.update();
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
    this.update();
  }
}
