import { Agent } from '@atproto/api';
import { VAULT_COLLECTION } from '../lexicon/build';
import type { VaultRecord } from '../lexicon/types';
import { fromB64, toB64 } from '../crypto/box';
import { makeCheckValue, verifyCheckValue } from '../crypto/check';
import { DEFAULT_KDF_PARAMS, deriveMasterKey, generateSalt } from '../crypto/keys';
import { RealPdsClient } from './pds-client';
import { login } from './login';
import type AtprotoSyncPlugin from './main';

/** Build (or reuse) a PDS client from whichever auth the user completed. */
export async function ensurePdsClient(plugin: AtprotoSyncPlugin): Promise<RealPdsClient> {
  if (plugin.pdsClient) return plugin.pdsClient;
  const s = plugin.settings;
  if (s.authMode === 'oauth' && s.authDid) {
    const session = await plugin.oauth.restore(s.authDid);
    plugin.pdsClient = new RealPdsClient(new Agent(session), s.authDid);
  } else if (s.identifier && s.appPassword) {
    plugin.pdsClient = await login({
      identifier: s.identifier,
      password: s.appPassword,
      pdsUrl: s.pdsUrlOverride || undefined,
    });
  } else {
    throw new Error('Sign in first.');
  }
  return plugin.pdsClient;
}

export interface VaultInfo {
  rkey: string;
  name: string;
  createdAt?: string;
}

/** All vault records on this account. Names are plaintext by design (the chooser needs them). */
export async function listVaults(plugin: AtprotoSyncPlugin): Promise<VaultInfo[]> {
  const pds = await ensurePdsClient(plugin);
  return (await pds.listRecords(VAULT_COLLECTION)).map((r) => {
    const rec = r.value as VaultRecord;
    return { rkey: r.rkey, name: rec.name, createdAt: rec.createdAt };
  });
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase for this vault.');
    this.name = 'WrongPassphraseError';
  }
}

/** Create a new vault record and bind this device to it. */
export async function createVault(
  plugin: AtprotoSyncPlugin,
  name: string,
  passphrase: string
): Promise<void> {
  const pds = await ensurePdsClient(plugin);
  const s = plugin.settings;
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
  s.vaultRkey = rkey;
  s.masterKeyB64 = await toB64(master);
  s.setupIncomplete = false;
  await plugin.saveSettings();
}

/** Verify a passphrase against a specific vault record and bind this device to it. */
export async function unlockVault(
  plugin: AtprotoSyncPlugin,
  rkey: string,
  passphrase: string
): Promise<void> {
  const pds = await ensurePdsClient(plugin);
  const s = plugin.settings;
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
  s.vaultRkey = rkey;
  s.masterKeyB64 = await toB64(master);
  s.setupIncomplete = false;
  await plugin.saveSettings();
}

/**
 * Name-based convenience used by the settings tab: bind to the vault matching
 * this folder's name, or create one if no vault carries that name.
 */
export async function setupVaultEncryption(
  plugin: AtprotoSyncPlugin,
  passphrase: string
): Promise<'created' | 'verified'> {
  const name = plugin.app.vault.getName();
  const match = (await listVaults(plugin)).find((v) => v.name === name);
  if (match) {
    await unlockVault(plugin, match.rkey, passphrase);
    return 'verified';
  }
  await createVault(plugin, name, passphrase);
  return 'created';
}
