/**
 * Cross-process vault lock: <vault>/.atpsync/lock created with O_EXCL.
 * The holder refreshes the file's mtime every heartbeatMs. A lock held on
 * this host is stale exactly when its pid is dead (a live local holder may be
 * suspended or stuck in a long sync; its heartbeat says nothing). A lock from
 * another host, or one whose holder is unreadable, is stale once its mtime is
 * older than staleMs (a crashed holder on another machine sharing the folder).
 */
import { promises as fs, type Stats } from 'node:fs';
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

export interface FileId {
  ino: number;
  dev: number;
  /** Inode numbers get reused right after an unlink, so creation time disambiguates. */
  birthtimeMs: number;
}

/** The identity of the lock file if it is stale, else null (also null if it vanished). */
export async function isStale(
  file: string,
  staleMs: number,
): Promise<FileId | null> {
  let st: Stats;
  try {
    st = await fs.stat(file);
  } catch {
    return null; // vanished: the next create attempt decides
  }
  const id = { ino: st.ino, dev: st.dev, birthtimeMs: st.birthtimeMs };
  const age = Date.now() - st.mtimeMs;
  const holder = await readHolder(file);
  if (holder && holder.host === os.hostname()) return isAlive(holder.pid) ? null : id;
  if (age > staleMs) return id;
  // Unreadable: possibly mid-write by its creator; only stale once it is a few seconds old.
  if (!holder) return age > 5_000 ? id : null;
  return null;
}

async function tryCreate(
  file: string,
  heartbeatMs: number,
): Promise<VaultLock | null> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const me: Holder = {
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
  };
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
      if (
        cur &&
        cur.pid === me.pid &&
        cur.host === me.host &&
        cur.startedAt === me.startedAt
      ) {
        await fs.rm(file, { force: true });
      }
    },
  };
}

export async function tryAcquireLock(
  vaultDir: string,
  opts: LockOptions = {},
): Promise<VaultLock | null> {
  const file = lockPath(vaultDir);
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const lock = await tryCreate(file, heartbeatMs);
  if (lock) return lock;
  const judged = await isStale(file, opts.staleMs ?? 2 * 60_000);
  if (judged) {
    if (!(await breakStale(file, judged))) return null;
    return tryCreate(file, heartbeatMs);
  }
  return null;
}

/**
 * Break the lock file identified by `judged` (inode + birthtime) without racing other breakers:
 * rename it aside (atomic, only one breaker wins), then check the renamed file's inode.
 * If it is not the file we judged, we moved someone else's fresh lock: hard-link it back
 * (fails with EEXIST rather than clobbering). Returns true if the path is free to create.
 */
export async function breakStale(
  file: string,
  judged: FileId,
): Promise<boolean> {
  const aside = `${file}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await fs.rename(file, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true; // someone else broke it first
    throw err;
  }
  const moved = await fs.stat(aside);
  if (
    moved.ino !== judged.ino ||
    moved.dev !== judged.dev ||
    moved.birthtimeMs !== judged.birthtimeMs
  ) {
    await restore(aside, file);
    return false;
  }
  await fs.rm(aside, { force: true });
  return true;
}

/**
 * Put a lock we moved by mistake back at `file` without clobbering a newer one.
 * Hard link first (EEXIST if the path was re-taken). Filesystems without hard
 * links (exFAT, some FUSE mounts) get a rename, but only while the path is free.
 */
async function restore(aside: string, file: string): Promise<void> {
  try {
    await fs.link(aside, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      const free = await fs.stat(file).then(
        () => false,
        (e: NodeJS.ErrnoException) => e.code === 'ENOENT',
      );
      if (free) {
        try {
          await fs.rename(aside, file);
          return;
        } catch {
          // fall through: drop the moved copy
        }
      }
    }
  }
  await fs.rm(aside, { force: true });
}

export async function acquireLock(
  vaultDir: string,
  opts: LockOptions = {},
): Promise<VaultLock> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    const lock = await tryAcquireLock(vaultDir, opts);
    if (lock) return lock;
    if (Date.now() >= deadline) {
      throw new AtpsyncError(
        'LOCK_TIMEOUT',
        'Timed out waiting for another atpsync process to finish syncing this vault.',
      );
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 250));
  }
}
