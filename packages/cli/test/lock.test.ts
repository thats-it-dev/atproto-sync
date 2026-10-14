import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { acquireLock, tryAcquireLock } from '../src/lock';
import { lockPath } from '../src/paths';
import { clearAtpsyncEnv, sleep, tempEnv } from './helpers';

afterEach(clearAtpsyncEnv);

async function writeLock(vaultDir: string, holder: object, ageMs = 0) {
  const file = lockPath(vaultDir);
  await fs.mkdir(`${vaultDir}/.atpsync`, { recursive: true });
  await fs.writeFile(file, JSON.stringify(holder));
  const t = new Date(Date.now() - ageMs);
  await fs.utimes(file, t, t);
}

describe('vault lock', () => {
  it('is exclusive until released', async () => {
    const { vaultDir } = await tempEnv();
    const a = await tryAcquireLock(vaultDir);
    expect(a).not.toBeNull();
    expect(await tryAcquireLock(vaultDir)).toBeNull();
    await a!.release();
    const b = await tryAcquireLock(vaultDir);
    expect(b).not.toBeNull();
    await b!.release();
    await expect(fs.access(lockPath(vaultDir))).rejects.toThrow();
  });

  it('breaks a lock held by a dead pid on this host', async () => {
    const { vaultDir } = await tempEnv();
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    await writeLock(vaultDir, { pid: dead, host: os.hostname(), startedAt: 'x' });
    const l = await tryAcquireLock(vaultDir);
    expect(l).not.toBeNull();
    await l!.release();
  });

  it('breaks a lock whose heartbeat is older than staleMs, even from another host', async () => {
    const { vaultDir } = await tempEnv();
    await writeLock(vaultDir, { pid: 1, host: 'other-host', startedAt: 'x' }, 3 * 60_000);
    const l = await tryAcquireLock(vaultDir);
    expect(l).not.toBeNull();
    await l!.release();
  });

  it('respects a fresh lock from another host', async () => {
    const { vaultDir } = await tempEnv();
    await writeLock(vaultDir, { pid: 1, host: 'other-host', startedAt: 'x' });
    expect(await tryAcquireLock(vaultDir)).toBeNull();
  });

  it('heartbeat keeps the lock fresh', async () => {
    const { vaultDir } = await tempEnv();
    const l = await tryAcquireLock(vaultDir, { heartbeatMs: 30 });
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(lockPath(vaultDir), old, old);
    await sleep(120);
    const { mtimeMs } = await fs.stat(lockPath(vaultDir));
    expect(Date.now() - mtimeMs).toBeLessThan(5_000);
    await l!.release();
  });

  it('acquireLock waits for release', async () => {
    const { vaultDir } = await tempEnv();
    const a = (await tryAcquireLock(vaultDir))!;
    setTimeout(() => void a.release(), 100);
    const b = await acquireLock(vaultDir, { timeoutMs: 2_000, pollMs: 20 });
    await b.release();
  });

  it('acquireLock times out with LOCK_TIMEOUT', async () => {
    const { vaultDir } = await tempEnv();
    const a = (await tryAcquireLock(vaultDir))!;
    await expect(acquireLock(vaultDir, { timeoutMs: 150, pollMs: 20 })).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    await a.release();
  });

  it('release does not delete a lock that was broken and re-taken by someone else', async () => {
    const { vaultDir } = await tempEnv();
    const a = (await tryAcquireLock(vaultDir))!;
    await writeLock(vaultDir, { pid: 1, host: 'other-host', startedAt: 'y' });
    await a.release();
    await expect(fs.access(lockPath(vaultDir))).resolves.toBeUndefined();
  });

  it('concurrent breakers of one stale lock yield exactly one holder', async () => {
    const { vaultDir } = await tempEnv();
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    await writeLock(vaultDir, { pid: dead, host: os.hostname(), startedAt: 'x' });
    const results = await Promise.all(Array.from({ length: 5 }, () => tryAcquireLock(vaultDir)));
    const held = results.filter((r) => r !== null);
    expect(held).toHaveLength(1);
    await held[0]!.release();
  });
});
