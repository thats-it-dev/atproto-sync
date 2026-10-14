import { spawn } from 'node:child_process';
import { closeSync, openSync, promises as fs } from 'node:fs';
import { boundVaultDir } from '../config';
import { readDaemonState } from '../daemon-state';
import { AtpsyncError } from '../errors';
import { logPath, stateDir } from '../paths';
import { isAlive, readLivePid, removePid } from '../pidfile';
import { requireConfig, type CommandDeps } from './context';
import { tailLog } from './logs';

export interface StartDeps {
  /** Node binary used to spawn the daemon. */
  execPath: string;
  /** Path to the CLI entry (the built bundle) the daemon is spawned from. */
  cliPath: string;
  /** How long `start` waits for the daemon to come up (default 3000 ms). */
  waitMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spawn `atpsync daemon` detached and wait until it has claimed the pidfile and written daemon.json. */
export async function startCommand(
  deps: CommandDeps,
  ctl: StartDeps
): Promise<{ ok: true; pid: number; logPath: string }> {
  const cfg = await requireConfig(deps);
  const vaultDir = boundVaultDir(cfg);
  const live = await readLivePid();
  if (live !== null) throw new AtpsyncError('ALREADY_RUNNING', `atpsync daemon is already running (pid ${live}).`);

  await fs.mkdir(stateDir(), { recursive: true });
  const fd = openSync(logPath(), 'a');
  const child = spawn(ctl.execPath, [ctl.cliPath, 'daemon'], {
    detached: true,
    stdio: ['ignore', 'ignore', fd],
    env: process.env,
  });
  closeSync(fd);
  let exitCode: number | null = null;
  child.once('exit', (code) => {
    exitCode = code ?? 1;
  });
  child.unref();

  const deadline = Date.now() + (ctl.waitMs ?? 3000);
  while (Date.now() < deadline && exitCode === null) {
    if ((await readLivePid()) === child.pid && (await readDaemonState(vaultDir))?.pid === child.pid) {
      return { ok: true, pid: child.pid!, logPath: logPath() };
    }
    await sleep(100);
  }
  const why = exitCode !== null ? ` (exited with code ${exitCode})` : ' (timed out)';
  throw new AtpsyncError('ERROR', `The daemon failed to start${why}. Last log lines:\n${await tailLog(20)}`);
}

/** process.kill that reports "already gone" (ESRCH) as false and refuses other users' processes. */
function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') throw new AtpsyncError('ERROR', `pid ${pid} belongs to another user; not stopping it`);
    throw err;
  }
}

/** SIGTERM the daemon, wait up to graceMs (default 10 s), then SIGKILL. */
export async function stopCommand(
  opts: { graceMs?: number } = {}
): Promise<{ ok: true; wasRunning: boolean; pid: number | null; forced: boolean }> {
  const pid = await readLivePid();
  if (pid === null) return { ok: true, wasRunning: false, pid: null, forced: false };
  if (!signal(pid, 'SIGTERM')) {
    // Exited between the pidfile check and the signal.
    await removePid(pid);
    return { ok: true, wasRunning: false, pid: null, forced: false };
  }
  const deadline = Date.now() + (opts.graceMs ?? 10_000);
  while (Date.now() < deadline && isAlive(pid)) await sleep(100);
  let forced = false;
  if (isAlive(pid) && signal(pid, 'SIGKILL')) {
    forced = true;
    for (let i = 0; i < 10 && isAlive(pid); i++) await sleep(100);
  }
  await removePid(pid);
  return { ok: true, wasRunning: true, pid, forced };
}
