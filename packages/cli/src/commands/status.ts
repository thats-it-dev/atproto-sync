import * as os from 'node:os';
import { boundVaultDir } from '../config';
import { readDaemonState, type DaemonState } from '../daemon-state';
import { readLivePid } from '../pidfile';
import { getVaultStatus, type VaultStatus } from '../session';
import { requireConfig, type CommandDeps } from './context';

export interface DaemonInfo {
  running: boolean;
  pid: number | null;
  connection: DaemonState['connection'] | null;
  lastSyncAt: string | null;
  lastError: string | null;
  lastExit: string | null;
}

export interface StatusResult extends VaultStatus {
  ok: true;
  daemon: DaemonInfo;
}

export async function statusCommand(deps: CommandDeps): Promise<StatusResult> {
  const cfg = await requireConfig(deps);
  const vaultDir = boundVaultDir(cfg);
  const [vault, pid, state] = await Promise.all([
    getVaultStatus(cfg, deps.connect),
    readLivePid(),
    readDaemonState(vaultDir),
  ]);
  const running = pid !== null;
  // daemon.json lives in the vault, which may be a folder shared with other
  // machines: only trust a record written on this host (by this daemon, if one runs).
  const mine = state && state.host === os.hostname() && (!running || state.pid === pid) ? state : null;
  return {
    ok: true,
    ...vault,
    daemon: {
      running,
      pid,
      connection: running ? (mine?.connection ?? null) : null,
      lastSyncAt: mine?.lastSyncAt ?? null,
      lastError: mine?.lastError ?? null,
      lastExit: running ? null : (mine?.lastExit ?? null),
    },
  };
}
