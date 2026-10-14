/**
 * Per-machine daemon files live in the XDG state dir (not the vault, which may
 * be shared storage); per-vault coordination files live in <vault>/.atpsync/.
 */
import * as os from 'node:os';
import * as path from 'node:path';

export function stateDir(): string {
  return (
    process.env.ATPSYNC_STATE_DIR ||
    path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'atpsync')
  );
}

export const pidPath = (): string => path.join(stateDir(), 'daemon.pid');
export const logPath = (): string => path.join(stateDir(), 'daemon.log');
export const lockPath = (vaultDir: string): string => path.join(vaultDir, '.atpsync', 'lock');
export const daemonStatePath = (vaultDir: string): string => path.join(vaultDir, '.atpsync', 'daemon.json');
