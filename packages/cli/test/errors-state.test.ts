import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { AtpsyncError, EXIT_CODES, toAtpsyncError } from '../src/errors';
import { pidPath, stateDir } from '../src/paths';
import { currentBootTime, isAlive, readLivePid, removePid, writePidExclusive } from '../src/pidfile';
import { stopCommand } from '../src/commands/daemon-control';
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

  it('writes JSON with the boot time', async () => {
    await tempEnv();
    await writePidExclusive(process.pid);
    const rec = JSON.parse(await fs.readFile(pidPath(), 'utf8'));
    expect(rec).toMatchObject({ pid: process.pid, startedAt: expect.any(String) });
    expect(Math.abs(rec.bootTime - currentBootTime())).toBeLessThan(5_000);
    await expect(fs.readdir(stateDir())).resolves.toEqual(['daemon.pid']);
  });

  it('treats a pidfile from before a reboot as stale even if the pid is alive now', async () => {
    await tempEnv();
    await fs.mkdir(stateDir(), { recursive: true });
    const rec = { pid: process.ppid, bootTime: currentBootTime() - 24 * 3600_000, startedAt: 'yesterday' };
    await fs.writeFile(pidPath(), JSON.stringify(rec));
    expect(isAlive(process.ppid)).toBe(true);
    expect(await readLivePid()).toBeNull();
    await expect(fs.access(pidPath())).rejects.toThrow();
  });

  it('accepts a legacy plain-number pidfile while that pid is alive; garbage is stale', async () => {
    await tempEnv();
    await fs.mkdir(stateDir(), { recursive: true });
    await fs.writeFile(pidPath(), `${process.ppid}\n`);
    expect(await readLivePid()).toBe(process.ppid);
    await fs.writeFile(pidPath(), 'not a pid');
    expect(await readLivePid()).toBeNull();
    await expect(fs.access(pidPath())).rejects.toThrow();
  });

  it('removePid leaves another process’s pidfile alone', async () => {
    await tempEnv();
    await writePidExclusive(process.ppid);
    await removePid(process.pid);
    expect(await readLivePid()).toBe(process.ppid);
  });
});

describe('stopCommand signalling', () => {
  // process.kill is mocked: signal 0 reports the pid alive, real signals behave as scripted.
  async function liveLooking(onSignal: () => never) {
    await tempEnv();
    await writePidExclusive(process.ppid);
    return vi.spyOn(process, 'kill').mockImplementation(((_pid: number, sig?: string | number) => {
      if (sig === 0 || sig === undefined) return true;
      return onSignal();
    }) as typeof process.kill);
  }
  const errno = (code: string) => Object.assign(new Error(code), { code });

  it('a daemon that exits just before SIGTERM counts as already stopped', async () => {
    const kill = await liveLooking(() => {
      throw errno('ESRCH');
    });
    try {
      await expect(stopCommand({ graceMs: 100 })).resolves.toMatchObject({ ok: true, wasRunning: false });
    } finally {
      kill.mockRestore();
    }
    await expect(fs.access(pidPath())).rejects.toThrow();
  });

  it('refuses to signal another user’s process', async () => {
    const kill = await liveLooking(() => {
      throw errno('EPERM');
    });
    try {
      await expect(stopCommand({ graceMs: 100 })).rejects.toMatchObject({
        code: 'ERROR',
        message: `pid ${process.ppid} belongs to another user; not stopping it`,
      });
    } finally {
      kill.mockRestore();
    }
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
