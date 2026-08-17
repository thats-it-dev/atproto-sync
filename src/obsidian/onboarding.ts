import { Agent } from '@atproto/api';
import { VAULT_COLLECTION } from '../lexicon/build';
import type { VaultRecord } from '../lexicon/types';
import { fromB64, toB64 } from '../crypto/box';
import { makeCheckValue, verifyCheckValue } from '../crypto/check';
import { DEFAULT_KDF_PARAMS, deriveMasterKey, generateSalt } from '../crypto/keys';
import { RealPdsClient, login } from './pds-client';
import type NoteskyPlugin from './main';

/** Build (or reuse) a PDS client from whichever auth the user completed. */
export async function ensurePdsClient(plugin: NoteskyPlugin): Promise<RealPdsClient> {
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

/** Whether this account already has a vault record (i.e. this is a later device). */
export async function vaultRecordExists(plugin: NoteskyPlugin): Promise<boolean> {
  const pds = await ensurePdsClient(plugin);
  return (await pds.listRecords(VAULT_COLLECTION)).length > 0;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase for this vault.');
    this.name = 'WrongPassphraseError';
  }
}

/**
 * First device: derive a master key and publish the vault record.
 * Later devices: verify the passphrase against the existing record.
 * Persists the derived key + vault rkey in settings on success.
 */
export async function setupVaultEncryption(
  plugin: NoteskyPlugin,
  passphrase: string
): Promise<'created' | 'verified'> {
  const pds = await ensurePdsClient(plugin);
  const s = plugin.settings;
  const vaults = await pds.listRecords(VAULT_COLLECTION);

  if (vaults.length === 0) {
    const salt = await generateSalt();
    const master = await deriveMasterKey(passphrase, salt, DEFAULT_KDF_PARAMS);
    const check = await makeCheckValue(master);
    const record: VaultRecord = {
      $type: 'app.notesky.vault',
      name: plugin.app.vault.getName(),
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
    await plugin.saveSettings();
    return 'created';
  }

  const { rkey, value } = vaults[0];
  const rec = value as VaultRecord;
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
  await plugin.saveSettings();
  return 'verified';
}
