import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { VAULT_COLLECTION } from '../lexicon/build';
import type { VaultRecord } from '../lexicon/types';
import { fromB64, toB64 } from '../crypto/box';
import { makeCheckValue, verifyCheckValue } from '../crypto/check';
import { DEFAULT_KDF_PARAMS, deriveMasterKey, generateSalt } from '../crypto/keys';
import { login } from './pds-client';
import type NoteskyPlugin from './main';

export const PASSPHRASE_WARNING =
  'If you lose this passphrase, encrypted notes on the server cannot be recovered by anyone — including us.';

export class NoteskySettingTab extends PluginSettingTab {
  private passphrase = '';

  constructor(
    app: App,
    private readonly plugin: NoteskyPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

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
      .setName('PDS URL (advanced)')
      .setDesc('Leave empty to auto-detect from your handle. Set for self-hosted or local testing, e.g. http://localhost:3000.')
      .addText((t) =>
        t.setPlaceholder('auto').setValue(s.pdsUrlOverride).onChange(async (v) => {
          s.pdsUrlOverride = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('App password')
      .setDesc('Create one in your PDS account settings — not your main password.')
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
            new Notice('Notesky: login OK');
          } catch (err) {
            new Notice(`Notesky: login failed — ${err instanceof Error ? err.message : err}`);
          }
        })
      );

    new Setting(containerEl).setName('Log out').addButton((b) =>
      b.setButtonText('Log out').onClick(async () => {
        s.appPassword = '';
        await this.plugin.saveSettings();
        this.plugin.disconnectEngine();
        this.display();
      })
    );

    // ── Encryption ─────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Encryption').setHeading();
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
          new Notice('Notesky: sync state cleared; next sync re-scans everything.');
          await this.plugin.runSync();
        })
      );

    new Setting(containerEl)
      .setName('Disconnect')
      .setDesc('Remove credentials and cached keys from this device. Notes stay on the PDS.')
      .addButton((b) =>
        b.setButtonText('Disconnect').setWarning().onClick(async () => {
          this.plugin.settings = {
            ...this.plugin.settings,
            identifier: '',
            appPassword: '',
            masterKeyB64: '',
            vaultRkey: '',
          };
          await this.plugin.saveSettings();
          this.plugin.disconnectEngine();
          this.display();
        })
      );
  }

  /** First device creates the vault record; later devices verify against it. */
  private async setupEncryption(): Promise<void> {
    const s = this.plugin.settings;
    if (!this.passphrase) {
      new Notice('Notesky: enter a passphrase first.');
      return;
    }
    if (!this.plugin.pdsClient) {
      try {
        this.plugin.pdsClient = await login({
          identifier: s.identifier,
          password: s.appPassword,
          pdsUrl: s.pdsUrlOverride || undefined,
        });
      } catch (err) {
        new Notice(`Notesky: log in first — ${err instanceof Error ? err.message : err}`);
        return;
      }
    }
    const pds = this.plugin.pdsClient;
    const vaults = await pds.listRecords(VAULT_COLLECTION);

    if (vaults.length === 0) {
      // First device: create the vault record.
      const salt = await generateSalt();
      const master = await deriveMasterKey(this.passphrase, salt, DEFAULT_KDF_PARAMS);
      const check = await makeCheckValue(master);
      const record: VaultRecord = {
        $type: 'app.notesky.vault',
        name: this.app.vault.getName(),
        formatVersion: 1,
        kdf: {
          alg: 'argon2id13',
          saltB64: await toB64(salt),
          opsLimit: DEFAULT_KDF_PARAMS.opsLimit,
          memLimit: DEFAULT_KDF_PARAMS.memLimit,
        },
        checkValue: {
          nonce: await toB64(check.nonce),
          ciphertext: await toB64(check.ciphertext),
        },
        createdAt: new Date().toISOString(),
      };
      const rkey = `vault${Date.now().toString(36)}`;
      await pds.putRecord(VAULT_COLLECTION, rkey, record, null);
      s.vaultRkey = rkey;
      s.masterKeyB64 = await toB64(master);
      await this.plugin.saveSettings();
      new Notice('Notesky: encryption set up. This vault is now syncing.');
    } else {
      // Later device: verify the passphrase against the existing vault record.
      const { rkey, value } = vaults[0];
      const rec = value as VaultRecord;
      const master = await deriveMasterKey(this.passphrase, await fromB64(rec.kdf.saltB64), {
        opsLimit: rec.kdf.opsLimit,
        memLimit: rec.kdf.memLimit,
      });
      const ok = await verifyCheckValue(
        {
          nonce: await fromB64(rec.checkValue.nonce),
          ciphertext: await fromB64(rec.checkValue.ciphertext),
        },
        master
      );
      if (!ok) {
        new Notice('Notesky: wrong passphrase for this vault.');
        return;
      }
      s.vaultRkey = rkey;
      s.masterKeyB64 = await toB64(master);
      await this.plugin.saveSettings();
      new Notice('Notesky: passphrase verified. This device is now syncing.');
    }
    this.passphrase = '';
    await this.plugin.initEngine();
    this.display();
  }
}
