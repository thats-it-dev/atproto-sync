import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { AtpsyncError, EXIT_CODES, toAtpsyncError } from '../src/errors';
import { pidPath, stateDir } from '../src/paths';
import { isAlive, readLivePid, removePid, writePidExclusive } from '../src/pidfile';
import { DaemonStateWriter, readDaemonState, type DaemonState } from '../src/daemon-state';
import { clearAtpsyncEnv, tempEnv } from './helpers';

afterEach(clearAtpsyncEnv);

/** A pid that is guaranteed dead: a child that already exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid!;
}

describe('errors', () => {
  it('maps codes to the spec exit codes', () => {
    expect(EXIT_CODES).toEqual({ ERROR: 1, USAGE: 2, NOT_CONFIGURED: 3, LOCK_TIMEOUT: 4, AUTH: 5, ALREADY_RUNNING: 1 });
  });
  it('wraps unknown errors as ERROR and passes AtpsyncError through', () => {
    const e = new AtpsyncError('AUTH', 'nope');
    expect(toAtpsyncError(e)).toBe(e);
    expect(toAtpsyncError(new Error('boom'))).toMatchObject({ code: 'ERROR', message: 'boom' });
    expect(toAtpsyncError('str')).toMatchObject({ code: 'ERROR', message: 'str' });
  });
});

describe('pidfile', () => {
  it('uses ATPSYNC_STATE_DIR', async () => {
    const { root } = await tempEnv();
    expect(stateDir()).toBe(`${root}/state`);
    expect(pidPath()).toBe(`${root}/state/daemon.pid`);
  });

  it('writes, reads and removes a live pid', async () => {
    await tempEnv();
    expect(await readLivePid()).toBeNull();
    await writePidExclusive(process.pid);
    expect(await readLivePid()).toBe(process.pid);
    await removePid(process.pid);
    expect(await readLivePid()).toBeNull();
  });

  it('treats a dead pid as stale and removes the file', async () => {
    await tempEnv();
    const dead = deadPid();
    expect(isAlive(dead)).toBe(false);
    await fs.mkdir(stateDir(), { recursive: true });
    await fs.writeFile(pidPath(), String(dead));
    expect(await readLivePid()).toBeNull();
    await expect(fs.access(pidPath())).rejects.toThrow();
  });

  it('refuses to overwrite a live pid', async () => {
    await tempEnv();
    await writePidExclusive(process.ppid);
    await expect(writePidExclusive(process.pid)).rejects.toMatchObject({ code: 'ALREADY_RUNNING' });
  });

  it('removePid leaves another process’s pidfile alone', async () => {
    await tempEnv();
    await writePidExclusive(process.ppid);
    await removePid(process.pid);
    expect(await readLivePid()).toBe(process.ppid);
  });
});

describe('daemon state', () => {
  it('writes daemon.json and merges updates', async () => {
    const { vaultDir } = await tempEnv();
    expect(await readDaemonState(vaultDir)).toBeNull();
    const initial: DaemonState = {
      pid: 1, host: 'h', startedAt: 't', connection: 'poll',
      lastSyncAt: null, lastResult: null, lastError: null, lastExit: null,
    };
    const w = new DaemonStateWriter(vaultDir, initial);
    await Promise.all([w.update({ lastResult: 'ok' }), w.update({ connection: 'subscribed' })]);
    expect(await readDaemonState(vaultDir)).toEqual({ ...initial, lastResult: 'ok', connection: 'subscribed' });
    expect(w.current.connection).toBe('subscribed');
  });
});
