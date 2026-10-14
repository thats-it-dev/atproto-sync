/**
 * Session wiring: build the PDS client and the SyncEngine from a config, and
 * run one sync pass. No Obsidian, no UI. Reuses the plugin's pure core.
 */
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { RealPdsClient, login } from '@atproto-sync/core/atproto/pds-client';
import type { PdsClient } from '@atproto-sync/core/sync/pds';
import { isPublicNote, removePublicFlag, setPublicFlag } from '@atproto-sync/core/publish/frontmatter';
import { fromB64 } from '@atproto-sync/core/crypto/box';
import {
  NOTE_COLLECTION,
  ATTACHMENT_COLLECTION,
  VAULT_COLLECTION,
} from '@atproto-sync/core/lexicon/build';
import type { VaultRecord } from '@atproto-sync/core/lexicon/types';
import { SyncEngine } from '@atproto-sync/core/sync/engine';
import { FsVaultAdapter, isMarkdownPath, resolveInsideVault } from './fs-vault';
import { FsIndexStore } from './fs-store';
import { resolvePdsUrl } from './resolve-pds';
import { AtpsyncError } from './errors';
import { boundVaultDir, isConfigured, loadConfig, saveConfig, type AtpsyncConfig } from './config';

export interface Connection {
  pds: PdsClient;
  did: string;
  pdsUrl: string;
}
export type Connect = (cfg: AtpsyncConfig) => Promise<Connection>;

export interface ConnectDeps {
  login?: typeof login;
  resolvePdsUrl?: typeof resolvePdsUrl;
}

let connCache: { key: string; conn: Connection } | null = null;

/** Drop the cached session (after logout, setup, or an auth failure). */
export function clearConnectionCache(): void {
  connCache = null;
}

export function isAuthFailure(err: unknown): boolean {
  const e = err as { status?: unknown; error?: unknown } | null;
  return Number(e?.status) === 401 || e?.error === 'AuthenticationRequired' || e?.error === 'ExpiredToken';
}

/** App-password login (cached per identifier + PDS override). */
export async function connect(cfg: AtpsyncConfig, deps: ConnectDeps = {}): Promise<Connection> {
  const key = `${cfg.identifier}|${cfg.pdsUrlOverride || ''}`;
  if (connCache && connCache.key === key) return connCache.conn;
  const pdsUrl = cfg.pdsUrlOverride || (await (deps.resolvePdsUrl ?? resolvePdsUrl)(cfg.identifier)).pdsUrl;
  let client: RealPdsClient;
  try {
    client = await (deps.login ?? login)({ identifier: cfg.identifier, password: cfg.appPassword, pdsUrl });
  } catch (err) {
    if (isAuthFailure(err)) {
      throw new AtpsyncError(
        'AUTH',
        `Sign-in failed for ${cfg.identifier} (${(err as Error).message}). Check the app password or run \`atpsync setup\`.`
      );
    }
    throw err;
  }
  const conn: Connection = { pds: client, did: client.did, pdsUrl };
  connCache = { key, conn };
  return conn;
}

export interface SyncSummary {
  ok: boolean;
  /** Total number of reconcile operations executed across all passes. */
  opsExecuted: number;
  warnings: string[];
  /** Attachment paths skipped because they exceed the PDS blob limit. */
  skippedPaths: string[];
  lastSyncAt: string;
  vaultDir: string;
}

export interface SyncHooks {
  onProgress?: (done: number, total: number) => void;
  onWarning?: (message: string) => void;
  /** Override the vault directory (config/env default) for this sync. */
  vaultDir?: string;
  /** Use this client instead of logging in (tests). */
  pds?: PdsClient;
}

/** Run one full sync (notes + attachments, including the CAS-retry pass). */
export async function runSync(
  cfg: AtpsyncConfig,
  hooks: SyncHooks = {}
): Promise<SyncSummary> {
  if (!isConfigured(cfg)) {
    throw new AtpsyncError('NOT_CONFIGURED', 'Not configured yet. Run `atpsync setup` first (handle, app password, passphrase).');
  }
  const vaultDir = boundVaultDir(cfg, hooks.vaultDir);
  const pds = hooks.pds ?? (await connect(cfg)).pds;
  const masterKey = await fromB64(cfg.masterKeyB64);

  const warnings: string[] = [];
  let ops = 0;
  const engine = new SyncEngine({
    pds,
    vault: new FsVaultAdapter(vaultDir, () => cfg.ignorePatterns),
    index: new FsIndexStore(path.join(vaultDir, '.atpsync', 'index.json')),
    masterKey,
    vaultRkey: cfg.vaultRkey,
    onProgress: (done, total) => {
      ops++;
      hooks.onProgress?.(done, total);
    },
    onWarning: (m) => {
      warnings.push(m);
      hooks.onWarning?.(m);
    },
  });

  await engine.sync();
  const lastSyncAt = new Date().toISOString();
  // Persist against a fresh read so we don't clobber concurrent config edits.
  await saveConfig({ ...(await loadConfig()), lastSyncAt });
  return {
    ok: true,
    opsExecuted: ops,
    warnings,
    skippedPaths: [...engine.lastSkippedPaths],
    lastSyncAt,
    vaultDir,
  };
}

export interface ToggleResult {
  changed: boolean;
  message: string;
  summary: SyncSummary | null;
}

/** Flip a note's public flag in its frontmatter, then sync. */
export async function togglePublic(
  cfg: AtpsyncConfig,
  relPath: string,
  makePublic: boolean,
  slug?: string,
  hooks: SyncHooks = {}
): Promise<ToggleResult> {
  const vaultDir = boundVaultDir(cfg, hooks.vaultDir);
  if (!isMarkdownPath(relPath)) {
    throw new Error(`"${relPath}" is not a markdown note; only .md files can be published.`);
  }
  const abs = resolveInsideVault(vaultDir, relPath);
  let content: string;
  try {
    content = await fs.readFile(abs, 'utf8');
  } catch {
    throw new Error(`No vault file at "${relPath}" (vault: ${vaultDir}).`);
  }
  const publicNow = isPublicNote(content);
  if (makePublic === publicNow) {
    return { changed: false, message: `No change: "${relPath}" is already ${publicNow ? 'public' : 'private'}.`, summary: null };
  }
  const next = makePublic ? setPublicFlag(content, slug) : removePublicFlag(content);
  await fs.writeFile(abs, next, 'utf8');
  const summary = await runSync(cfg, hooks);
  const message = makePublic
    ? `"${relPath}" is now public${slug ? ` at /${slug}` : ''} (plaintext record, embedded attachments cascade to public).`
    : `"${relPath}" is now private again (record re-encrypted, key rotated).`;
  return { changed: true, message, summary };
}

export function formatSummary(summary: {
  opsExecuted: number;
  warnings: string[];
  skippedPaths: string[];
  lastSyncAt: string;
}): string {
  const lines = [`Sync complete: ${summary.opsExecuted} operation(s) at ${summary.lastSyncAt}.`];
  if (summary.warnings.length) {
    lines.push('Warnings:');
    for (const w of summary.warnings) lines.push(`  - ${w}`);
  }
  if (summary.skippedPaths.length) {
    lines.push(`Skipped (too large for PDS): ${summary.skippedPaths.join(', ')}`);
  }
  return lines.join('\n');
}

export interface VaultStatus {
  identifier: string;
  vaultRkey: string;
  vaultDir: string;
  vaultName: string | null;
  pdsUrl: string | null;
  localNotes: number;
  /** null when the PDS could not be reached (see remoteError). */
  remote: { notes: number; attachments: number } | null;
  remoteError: string | null;
  lastSyncAt: string | null;
}

/** Snapshot of the account/vault state. Local counts always; remote counts when reachable. */
export async function getVaultStatus(cfg: AtpsyncConfig, connectFn: Connect = connect): Promise<VaultStatus> {
  const vaultDir = boundVaultDir(cfg);
  const localNotes = await new FsVaultAdapter(vaultDir, () => cfg.ignorePatterns).countMarkdown();
  const status: VaultStatus = {
    identifier: cfg.identifier,
    vaultRkey: cfg.vaultRkey,
    vaultDir,
    vaultName: null,
    pdsUrl: cfg.pdsUrlOverride || null,
    localNotes,
    remote: null,
    remoteError: null,
    lastSyncAt: cfg.lastSyncAt ?? null,
  };
  try {
    const { pds, pdsUrl } = await connectFn(cfg);
    const [notes, atts, vaultRec] = await Promise.all([
      pds.listRecords(NOTE_COLLECTION),
      pds.listRecords(ATTACHMENT_COLLECTION),
      pds.getRecord(VAULT_COLLECTION, cfg.vaultRkey),
    ]);
    const mine = (r: { value: unknown }) => (r.value as { vault?: string }).vault === cfg.vaultRkey;
    status.pdsUrl = pdsUrl;
    status.remote = { notes: notes.filter(mine).length, attachments: atts.filter(mine).length };
    if (vaultRec) status.vaultName = (vaultRec.value as VaultRecord).name ?? null;
  } catch (err) {
    status.remoteError = (err as Error).message;
  }
  return status;
}
