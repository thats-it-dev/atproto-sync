/** Shared plumbing for command functions (used by both the CLI and the MCP server). */
import { configPath, isConfigured, loadConfig, type AtpsyncConfig } from '../config';
import { AtpsyncError } from '../errors';
import { acquireLock, tryAcquireLock } from '../lock';
import { connect, type Connect } from '../session';

export interface CommandDeps {
  loadConfig(): Promise<AtpsyncConfig>;
  connect: Connect;
  lock: { wait: boolean; timeoutMs: number };
}

export function defaultDeps(): CommandDeps {
  return { loadConfig, connect: (cfg) => connect(cfg), lock: { wait: true, timeoutMs: 60_000 } };
}

export async function requireConfig(deps: CommandDeps): Promise<AtpsyncConfig> {
  const cfg = await deps.loadConfig();
  if (!isConfigured(cfg)) {
    throw new AtpsyncError(
      'NOT_CONFIGURED',
      `atpsync is not configured on this machine (${configPath()}). Run \`atpsync setup\` first.`
    );
  }
  return cfg;
}

export async function withVaultLock<T>(
  vaultDir: string,
  lock: CommandDeps['lock'],
  fn: () => Promise<T>
): Promise<T> {
  const held = lock.wait ? await acquireLock(vaultDir, { timeoutMs: lock.timeoutMs }) : await tryAcquireLock(vaultDir);
  if (!held) {
    throw new AtpsyncError('LOCK_TIMEOUT', 'Another atpsync process is syncing this vault right now.');
  }
  try {
    return await fn();
  } finally {
    await held.release();
  }
}
