/**
 * Vault onboarding for the CLI/pi context (port of src/obsidian/onboarding.ts,
 * minus the Obsidian plugin coupling). Operates on any PdsClient so it is
 * unit-testable with FakePds.
 */
import * as path from 'node:path';
import { VAULT_COLLECTION } from '@atproto-sync/core/lexicon/build';
import type { VaultRecord } from '@atproto-sync/core/lexicon/types';
import { fromB64, toB64 } from '@atproto-sync/core/crypto/box';
import { makeCheckValue, verifyCheckValue } from '@atproto-sync/core/crypto/check';
import { DEFAULT_KDF_PARAMS, deriveMasterKey, generateSalt } from '@atproto-sync/core/crypto/keys';
import type { PdsClient } from '@atproto-sync/core/sync/pds';
import { login as realLogin } from '@atproto-sync/core/atproto/pds-client';
import { ensureVaultDir, expandVaultPath, loadConfig, saveConfig } from './config';
import { resolvePdsUrl } from './resolve-pds';

export interface VaultInfo {
  rkey: string;
  name: string;
  createdAt?: string;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase for this vault.');
    this.name = 'WrongPassphraseError';
  }
}

/** All vault records on this account. Names are plaintext by design (the chooser needs them). */
export async function listVaults(pds: PdsClient): Promise<VaultInfo[]> {
  return (await pds.listRecords(VAULT_COLLECTION)).map((r) => {
    const rec = r.value as VaultRecord;
    return { rkey: r.rkey, name: rec.name, createdAt: rec.createdAt };
  });
}

/** Create a new vault record and bind this device to it. */
export async function createVault(
  pds: PdsClient,
  name: string,
  passphrase: string
): Promise<{ vaultRkey: string; masterKeyB64: string }> {
  const salt = await generateSalt();
  const master = await deriveMasterKey(passphrase, salt, DEFAULT_KDF_PARAMS);
  const check = await makeCheckValue(master);
  const record: VaultRecord = {
    $type: 'app.notesky.vault',
    name,
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
  return { vaultRkey: rkey, masterKeyB64: await toB64(master) };
}

/** Verify a passphrase against a specific vault record and bind this device to it. */
export async function unlockVault(
  pds: PdsClient,
  rkey: string,
  passphrase: string
): Promise<{ masterKeyB64: string; vaultName: string }> {
  const record = await pds.getRecord(VAULT_COLLECTION, rkey);
  if (!record) throw new Error('That vault no longer exists on your account.');
  const rec = record.value as VaultRecord;
  const master = await deriveMasterKey(passphrase, await fromB64(rec.kdf.saltB64), {
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
  if (!ok) throw new WrongPassphraseError();
  return { masterKeyB64: await toB64(master), vaultName: rec.name };
}

/** The slice of pi's ExtensionContext that setup needs (so it can run against fakes). */
export interface SetupIO {
  /** Working directory; relative vault paths resolve against it and it is the first-run prompt default. */
  cwd: string;
  hasUI: boolean;
  /** Vault folder given on the command line (`/atpsync setup <dir>`). */
  vaultDir?: string;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
}

export interface SetupDeps {
  login: (identifier: string, password: string, pdsUrlOverride?: string) => Promise<PdsClient>;
}

const defaultDeps: SetupDeps = {
  login: (identifier, password, pdsUrl) =>
    realLogin({ identifier, password, pdsUrl: pdsUrl || undefined }, resolvePdsUrl),
};

/**
 * Interactive onboarding: handle, app password, vault folder, choose/create
 * vault, passphrase. The vault folder comes from the command argument, else
 * ATPSYNC_VAULT_DIR, else a prompt (default: previously bound folder, or the
 * cwd on first setup); it is created if missing. Headless (no UI) runs take
 * every input from env: ATPSYNC_HANDLE, ATPSYNC_APP_PASSWORD, ATPSYNC_VAULT_DIR,
 * ATPSYNC_PASSPHRASE, and optionally ATPSYNC_VAULT_RKEY (join an existing
 * vault) / ATPSYNC_VAULT_NAME.
 */
/** Command arg > ATPSYNC_VAULT_DIR > UI prompt (default: saved folder or cwd) > saved folder (headless). */
async function chooseVaultDir(io: SetupIO, savedDir: string): Promise<string> {
  const given = io.vaultDir?.trim() || process.env.ATPSYNC_VAULT_DIR?.trim();
  if (given) return expandVaultPath(given, io.cwd);
  if (io.hasUI) {
    const fallback = savedDir || io.cwd;
    const answer = await io.input(`Vault folder to sync (Enter for ${fallback})`, fallback);
    if (answer === undefined) throw new Error('setup aborted');
    return expandVaultPath(answer.trim() || fallback, io.cwd);
  }
  if (savedDir) return savedDir;
  throw new Error('setup needs a vault folder: run /atpsync setup <dir>, or set ATPSYNC_VAULT_DIR when headless.');
}

export async function runSetup(io: SetupIO, deps: SetupDeps = defaultDeps): Promise<void> {
  const cfg = await loadConfig();

  const ask = (title: string, fallbackEnv?: string): Promise<string | undefined> => {
    if (!io.hasUI) {
      const v = fallbackEnv ? process.env[fallbackEnv] : undefined;
      return Promise.resolve(v?.trim() ? v.trim() : undefined);
    }
    return io.input(title);
  };

  let identifier = cfg.identifier.trim();
  if (!identifier) identifier = (await ask('ATProto handle (e.g. you.bsky.social)', 'ATPSYNC_HANDLE')) ?? '';
  let appPassword = cfg.appPassword;
  if (!appPassword) {
    appPassword =
      (await ask('App password for that handle (create one in your PDS app-password settings)', 'ATPSYNC_APP_PASSWORD')) ?? '';
  }
  if (!identifier || !appPassword) {
    io.notify('ATProto Sync setup: need both a handle and an app password (UI prompts or ATPSYNC_HANDLE / ATPSYNC_APP_PASSWORD).', 'error');
    return;
  }

  const vaultDir = await chooseVaultDir(io, cfg.vaultDir);
  await ensureVaultDir(vaultDir);

  io.notify('ATProto Sync: signing in…', 'info');
  const pds = await deps.login(identifier, appPassword, cfg.pdsUrlOverride);

  const vaults = await listVaults(pds);
  const defaultName = path.basename(vaultDir);

  const askPassphrase = (title: string) => ask(title, 'ATPSYNC_PASSPHRASE');

  let vaultRkey: string;
  let masterKeyB64: string;
  const headlessRkey = !io.hasUI ? process.env.ATPSYNC_VAULT_RKEY?.trim() : undefined;
  if (headlessRkey) {
    const target = vaults.find((v) => v.rkey === headlessRkey);
    if (!target) throw new Error(`ATPSYNC_VAULT_RKEY "${headlessRkey}" is not a vault on this account.`);
    const passphrase = (await askPassphrase('Vault passphrase')) ?? '';
    if (!passphrase) throw new Error('setup aborted: no passphrase (set ATPSYNC_PASSPHRASE)');
    const r = await unlockVault(pds, target.rkey, passphrase);
    vaultRkey = target.rkey;
    masterKeyB64 = r.masterKeyB64;
  } else if (vaults.length > 0 && io.hasUI) {
    const options = [...vaults.map((v) => `${v.name}  (${v.rkey})`), 'create a new vault'];
    const choice = await io.select('Choose the vault to sync with this folder', options);
    if (!choice) throw new Error('setup aborted');
    const existing = vaults.find((v) => `${v.name}  (${v.rkey})` === choice);
    const passphrase = (await askPassphrase('Vault passphrase (same on every device; type it carefully)')) ?? '';
    if (!passphrase) throw new Error('setup aborted: no passphrase');
    if (existing) {
      const r = await unlockVault(pds, existing.rkey, passphrase);
      vaultRkey = existing.rkey;
      masterKeyB64 = r.masterKeyB64;
    } else {
      const name = (await ask(`Name for the new vault (default: ${defaultName})`, 'ATPSYNC_VAULT_NAME')) || defaultName;
      const r = await createVault(pds, name, passphrase);
      vaultRkey = r.vaultRkey;
      masterKeyB64 = r.masterKeyB64;
    }
  } else {
    if (vaults.length > 0) {
      io.notify(
        `Existing vaults on this account: ${vaults.map((v) => `${v.name} (${v.rkey})`).join(', ')}. ` +
          'Set ATPSYNC_VAULT_RKEY to join one; creating a new vault instead.',
        'warning'
      );
    }
    const name = (await ask(`Name for the new vault (default: ${defaultName})`, 'ATPSYNC_VAULT_NAME')) || defaultName;
    const passphrase = (await askPassphrase('Vault passphrase (type it carefully — you need it on every device)')) ?? '';
    if (!passphrase) throw new Error('setup aborted: no passphrase (set ATPSYNC_PASSPHRASE when headless)');
    const r = await createVault(pds, name, passphrase);
    vaultRkey = r.vaultRkey;
    masterKeyB64 = r.masterKeyB64;
  }

  await saveConfig({ ...cfg, identifier, appPassword, vaultRkey, masterKeyB64, vaultDir });
  io.notify(
    `ATProto Sync: signed in as ${identifier}, bound "${vaultDir}" to vault "${vaultRkey}". Run /atpsync sync to start.`,
    'info'
  );
}
