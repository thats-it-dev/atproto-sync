/**
 * Global atpsync config for the pi extension / CLI.
 *
 * Lives outside the vault at ~/.config/atpsync/config.json (0600). Holds auth
 * (app password), the vault binding (vaultRkey), and the cached master key.
 * The sync index itself lives per-vault at <vault>/.atpsync/index.json.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface AtpsyncConfig {
  /** ATProto handle, e.g. you.bsky.social */
  identifier: string;
  /** App password created in the PDS account settings. */
  appPassword: string;
  /** Direct PDS URL; skips handle resolution (self-hosted / local testing). */
  pdsUrlOverride: string;
  /** rkey of the app.notesky.vault record this device is bound to. */
  vaultRkey: string;
  /** Cached master key (base64, device-local). Set after passphrase entry. */
  masterKeyB64: string;
  /** Absolute vault dir bound by setup; empty until setup runs. */
  vaultDir: string;
  ignorePatterns: string[];
  syncIntervalMinutes: number;
  lastSyncAt?: string;
}

export const DEFAULT_IGNORES = ['.obsidian/', '.atpsync/', '.git/', 'node_modules/', 'Sync Conflicts/'];

export const DEFAULT_CONFIG: AtpsyncConfig = {
  identifier: '',
  appPassword: '',
  pdsUrlOverride: '',
  vaultRkey: '',
  masterKeyB64: '',
  vaultDir: '',
  ignorePatterns: [...DEFAULT_IGNORES],
  syncIntervalMinutes: 5,
};

export function configDir(): string {
  return (
    process.env.ATPSYNC_CONFIG_DIR ||
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'atpsync')
  );
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

export async function loadConfig(): Promise<AtpsyncConfig> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AtpsyncConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG, ignorePatterns: [...DEFAULT_IGNORES] };
  }
}

export async function saveConfig(cfg: AtpsyncConfig): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true });
  const p = configPath();
  await fs.writeFile(p, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  // Re-assert permissions in case the file pre-existed with looser modes.
  await fs.chmod(p, 0o600).catch(() => {});
}

export function isConfigured(cfg: AtpsyncConfig): boolean {
  return Boolean(cfg.identifier && cfg.appPassword && cfg.vaultRkey && cfg.masterKeyB64);
}

/** Expand a leading `~` and resolve relative paths against cwd. */
export function expandVaultPath(input: string, cwd: string): string {
  let p = input.trim();
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(cwd, p);
}

/**
 * Make sure the vault folder exists, creating it (and parents) if missing.
 * Rejects a path that exists but is not a directory.
 */
export async function ensureVaultDir(dir: string): Promise<void> {
  let st;
  try {
    st = await fs.stat(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
    return;
  }
  if (!st.isDirectory()) throw new Error(`Vault path "${dir}" exists but is not a directory.`);
}

/**
 * Vault dir for sync/status/publish/watch: explicit arg > env > config. Never
 * the cwd, so running from an unrelated directory can't pull a whole vault
 * into it (or push that directory's contents to the PDS).
 */
export function boundVaultDir(cfg: AtpsyncConfig, explicit?: string): string {
  const dir = explicit || process.env.ATPSYNC_VAULT_DIR || cfg.vaultDir;
  if (!dir) {
    throw new Error(
      'No vault directory is bound. Run /atpsync setup [folder], or set ATPSYNC_VAULT_DIR.'
    );
  }
  return path.resolve(dir);
}
