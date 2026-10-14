/** The daemon pidfile: one daemon per machine, stale entries cleaned up on read. */
import { promises as fs } from 'node:fs';
import { AtpsyncError } from './errors';
import { pidPath, stateDir } from './paths';

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readPid(): Promise<number | null> {
  try {
    const n = Number.parseInt((await fs.readFile(pidPath(), 'utf8')).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** The running daemon's pid, or null. A pidfile naming a dead process is removed. */
export async function readLivePid(): Promise<number | null> {
  const pid = await readPid();
  if (pid === null) return null;
  if (isAlive(pid)) return pid;
  await fs.rm(pidPath(), { force: true });
  return null;
}

/** Claim the pidfile for `pid`; throws ALREADY_RUNNING if a live daemon holds it. */
export async function writePidExclusive(pid: number): Promise<void> {
  await fs.mkdir(stateDir(), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(pidPath(), String(pid), { flag: 'wx' });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const live = await readLivePid(); // removes a stale file
      if (live !== null) {
        throw new AtpsyncError('ALREADY_RUNNING', `atpsync daemon is already running (pid ${live}).`);
      }
    }
  }
  throw new AtpsyncError('ERROR', `Could not write ${pidPath()}.`);
}

/** Remove the pidfile; with `expected`, only if it still names that pid. */
export async function removePid(expected?: number): Promise<void> {
  if (expected !== undefined && (await readPid()) !== expected) return;
  await fs.rm(pidPath(), { force: true });
}
