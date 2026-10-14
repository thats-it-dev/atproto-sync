/**
 * Cross-process vault lock: <vault>/.atpsync/lock created with O_EXCL.
 * The holder refreshes the file's mtime every heartbeatMs; a lock is stale if
 * its holder is a dead pid on this host, or its mtime is older than staleMs
 * (a crashed holder on another machine sharing the folder).
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AtpsyncError } from './errors';
import { lockPath } from './paths';
import { isAlive } from './pidfile';

export interface VaultLock {
  release(): Promise<void>;
}

export interface LockOptions {
  /** acquireLock only: how long to wait (default 60 s). */
  timeoutMs?: number;
  /** acquireLock only: retry interval (default 250 ms). */
  pollMs?: number;
  heartbeatMs?: number;
  staleMs?: number;
}

interface Holder {
  pid: number;
  host: string;
  startedAt: string;
}

async function readHolder(file: string): Promise<Holder | null> {
  try {
    const h = JSON.parse(await fs.readFile(file, 'utf8')) as Holder;
    return typeof h.pid === 'number' && typeof h.host === 'string' ? h : null;
  } catch {
    return null;
  }
}

async function isStale(file: string, staleMs: number): Promise<boolean> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(file)).mtimeMs;
  } catch {
    return false; // vanished: the next create attempt decides
  }
  const age = Date.now() - mtimeMs;
  if (age > staleMs) return true;
  const holder = await readHolder(file);
  // Unreadable: possibly mid-write by its creator; only stale once it is a few seconds old.
  if (!holder) return age > 5_000;
  return holder.host === os.hostname() && !isAlive(holder.pid);
}

async function tryCreate(file: string, heartbeatMs: number): Promise<VaultLock | null> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const me: Holder = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() };
  try {
    await fs.writeFile(file, JSON.stringify(me), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    void fs.utimes(file, now, now).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref();
  return {
    async release() {
      clearInterval(heartbeat);
      const cur = await readHolder(file);
      if (cur && cur.pid === me.pid && cur.host === me.host && cur.startedAt === me.startedAt) {
        await fs.rm(file, { force: true });
      }
    },
  };
}

export async function tryAcquireLock(vaultDir: string, opts: LockOptions = {}): Promise<VaultLock | null> {
  const file = lockPath(vaultDir);
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const lock = await tryCreate(file, heartbeatMs);
  if (lock) return lock;
  if (await isStale(file, opts.staleMs ?? 2 * 60_000)) {
    await fs.rm(file, { force: true });
    return tryCreate(file, heartbeatMs);
  }
  return null;
}

export async function acquireLock(vaultDir: string, opts: LockOptions = {}): Promise<VaultLock> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    const lock = await tryAcquireLock(vaultDir, opts);
    if (lock) return lock;
    if (Date.now() >= deadline) {
      throw new AtpsyncError(
        'LOCK_TIMEOUT',
        'Timed out waiting for another atpsync process to finish syncing this vault.'
      );
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 250));
  }
}
