/**
 * The daemon pidfile: one daemon per machine, stale entries cleaned up on read.
 * Contents: JSON { pid, bootTime, startedAt }. bootTime (epoch ms) tells a pid
 * recorded before a reboot apart from an unrelated process that reuses it.
 * A legacy plain-number pidfile is honoured while that pid is alive.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { AtpsyncError } from './errors';
import { pidPath, stateDir } from './paths';

/** Two boot-time estimates further apart than this mean a reboot happened. */
const BOOT_TOLERANCE_MS = 120_000;

export interface PidRecord {
  pid: number;
  /** Absent for a legacy plain-number pidfile. */
  bootTime?: number;
  startedAt?: string;
}

export function currentBootTime(): number {
  return Math.round(Date.now() - os.uptime() * 1000);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Parse pidfile contents; null when unparseable. */
export function parsePidRecord(raw: string): PidRecord | null {
  const text = raw.trim();
  if (/^\d+$/.test(text)) {
    const pid = Number(text);
    return pid > 0 ? { pid } : null;
  }
  try {
    const r = JSON.parse(text) as PidRecord;
    if (typeof r?.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) return null;
    return { pid: r.pid, bootTime: typeof r.bootTime === 'number' ? r.bootTime : undefined, startedAt: r.startedAt };
  } catch {
    return null;
  }
}

async function readRaw(): Promise<string | null> {
  try {
    return await fs.readFile(pidPath(), 'utf8');
  } catch {
    return null;
  }
}

function isLive(rec: PidRecord | null): rec is PidRecord {
  if (!rec || !isAlive(rec.pid)) return false;
  if (rec.bootTime === undefined) return true; // legacy: alive is all we can check
  return Math.abs(rec.bootTime - currentBootTime()) <= BOOT_TOLERANCE_MS;
}

/**
 * The running daemon's pid, or null. A stale pidfile (dead pid, recorded
 * before a reboot, or unparseable) is removed, but only if it still holds the
 * contents judged stale, so a daemon that just claimed it is left alone.
 */
export async function readLivePid(): Promise<number | null> {
  const raw = await readRaw();
  if (raw === null) return null;
  const rec = parsePidRecord(raw);
  if (isLive(rec)) return rec.pid;
  if ((await readRaw()) === raw) await fs.rm(pidPath(), { force: true });
  return null;
}

/** Claim the pidfile for `pid`; throws ALREADY_RUNNING if a live daemon holds it. */
export async function writePidExclusive(pid: number): Promise<void> {
  await fs.mkdir(stateDir(), { recursive: true });
  const record: PidRecord = { pid, bootTime: currentBootTime(), startedAt: new Date().toISOString() };
  const body = JSON.stringify(record);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await createExclusive(body);
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

/**
 * Create the pidfile with its full contents in one step: write a temp file and
 * hard-link it into place (EEXIST if taken), so readers never see it empty.
 * Falls back to an O_EXCL write where hard links are unsupported.
 */
async function createExclusive(body: string): Promise<void> {
  const file = pidPath();
  const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, body, 'utf8');
  try {
    await fs.link(tmp, file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw err;
    await fs.writeFile(file, body, { flag: 'wx' });
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/** Remove the pidfile; with `expected`, only if it still names that pid. */
export async function removePid(expected?: number): Promise<void> {
  if (expected !== undefined) {
    const raw = await readRaw();
    if (raw === null || parsePidRecord(raw)?.pid !== expected) return;
  }
  await fs.rm(pidPath(), { force: true });
}
