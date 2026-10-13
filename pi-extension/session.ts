/**
 * Session wiring: build the PDS client and the SyncEngine from a config, and
 * run one sync pass. No Obsidian, no UI. Reuses the plugin's pure core.
 */
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { RealPdsClient, login } from '../src/obsidian/pds-client';
import type { PdsClient } from '../src/sync/pds';
import { isPublicNote, removePublicFlag, setPublicFlag } from '../src/publish/frontmatter';
import { fromB64 } from '../src/crypto/box';
import {
  NOTE_COLLECTION,
  ATTACHMENT_COLLECTION,
  VAULT_COLLECTION,
} from '../src/lexicon/build';
import type { VaultRecord } from '../src/lexicon/types';
import { SyncEngine } from '../src/sync/engine';
import { FsVaultAdapter, isMarkdownPath, resolveInsideVault } from './fs-vault';
import { FsIndexStore } from './fs-store';
import { resolvePdsUrl } from './resolve-pds';
import { boundVaultDir, isConfigured, loadConfig, saveConfig, type AtpsyncConfig } from './config';

let pdsCache: { key: string; pds: RealPdsClient } | null = null;

/** Drop the cached PDS client (after logout / config change). */
export function clearPdsCache(): void {
  pdsCache = null;
}

/** App-password login (cached per identifier+service). */
export function makePdsClient(cfg: AtpsyncConfig): Promise<RealPdsClient> {
  const key = `${cfg.identifier}|${cfg.pdsUrlOverride || ''}`;
  if (pdsCache && pdsCache.key === key) return Promise.resolve(pdsCache.pds);
  return login(
    {
      identifier: cfg.identifier,
      password: cfg.appPassword,
      pdsUrl: cfg.pdsUrlOverride || undefined,
    },
    resolvePdsUrl
  ).then((pds) => {
    pdsCache = { key, pds };
    return pds;
  });
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
  _cwd: string,
  hooks: SyncHooks = {}
): Promise<SyncSummary> {
  if (!isConfigured(cfg)) {
    throw new Error(
      'Not configured yet. Run /atpsync setup first (handle, app password, passphrase).'
    );
  }
  const vaultDir = boundVaultDir(cfg, hooks.vaultDir);
  const pds = hooks.pds ?? (await makePdsClient(cfg));
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

/** Flip a note's public flag in its frontmatter, then sync. Returns a human summary. */
export async function togglePublic(
  cfg: AtpsyncConfig,
  cwd: string,
  relPath: string,
  makePublic: boolean,
  slug?: string,
  hooks: SyncHooks = {}
): Promise<string> {
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
    return `No change: "${relPath}" is already ${publicNow ? 'public' : 'private'}.`;
  }
  const next = makePublic ? setPublicFlag(content, slug) : removePublicFlag(content);
  await fs.writeFile(abs, next, 'utf8');
  const summary = await runSync(cfg, cwd, hooks);
  const msg = makePublic
    ? `"${relPath}" is now public${slug ? ` at /${slug}` : ''} (plaintext record, embedded attachments cascade to public).`
    : `"${relPath}" is now private again (record re-encrypted, key rotated).`;
  return [msg, formatSummary(summary)].join('\n');
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
  pdsUrl: string;
  vaultRkey: string;
  vaultName: string | null;
  vaultDir: string;
  localNotes: number;
  remoteNotes: number;
  remoteAttachments: number;
  lastSyncAt?: string;
}

/** Read-only snapshot of the account/vault state (logs in to count records). */
export async function getVaultStatus(
  cfg: AtpsyncConfig,
  _cwd: string
): Promise<VaultStatus> {
  const vaultDir = boundVaultDir(cfg);
  const vault = new FsVaultAdapter(vaultDir, () => cfg.ignorePatterns);
  const localNotes = await vault.countMarkdown();

  let vaultName: string | null = null;
  let remoteNotes = 0;
  let remoteAttachments = 0;
  if (isConfigured(cfg)) {
    const pds = await makePdsClient(cfg);
    const [notes, atts, vaultRec] = await Promise.all([
      pds.listRecords(NOTE_COLLECTION),
      pds.listRecords(ATTACHMENT_COLLECTION),
      pds.getRecord(VAULT_COLLECTION, cfg.vaultRkey),
    ]);
    remoteNotes = notes.filter(
      (r) => (r.value as { vault?: string }).vault === cfg.vaultRkey
    ).length;
    remoteAttachments = atts.filter(
      (r) => (r.value as { vault?: string }).vault === cfg.vaultRkey
    ).length;
    if (vaultRec) vaultName = (vaultRec.value as VaultRecord).name ?? null;
  }

  return {
    identifier: cfg.identifier,
    pdsUrl: cfg.pdsUrlOverride || '(resolved from handle)',
    vaultRkey: cfg.vaultRkey,
    vaultName,
    vaultDir,
    localNotes,
    remoteNotes,
    remoteAttachments,
    lastSyncAt: cfg.lastSyncAt,
  };
}
