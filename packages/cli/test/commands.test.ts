import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FakePds } from '@atproto-sync/core/sync/fake-pds';
import { DEFAULT_CONFIG, saveConfig, type AtpsyncConfig } from '../src/config';
import type { CommandDeps } from '../src/commands/context';
import { statusCommand } from '../src/commands/status';
import { syncCommand } from '../src/commands/sync';
import { publishCommand } from '../src/commands/publish';
import { renderStatus } from '../src/render';
import { tryAcquireLock } from '../src/lock';
import { daemonStatePath } from '../src/paths';
import { writePidExclusive } from '../src/pidfile';
import { clearAtpsyncEnv, configuredCfg, tempEnv } from './helpers';

afterEach(clearAtpsyncEnv);

function depsFor(cfg: AtpsyncConfig, pds = new FakePds(), lock = { wait: true, timeoutMs: 2000 }): CommandDeps {
  return {
    loadConfig: async () => cfg,
    connect: async () => ({ pds, did: 'did:plc:me', pdsUrl: 'http://fake' }),
    lock,
  };
}

async function setup() {
  const { vaultDir } = await tempEnv();
  const cfg = await configuredCfg(vaultDir);
  await saveConfig(cfg);
  return { vaultDir, cfg };
}

describe('commands', () => {
  it('every command refuses with NOT_CONFIGURED before setup', async () => {
    await tempEnv();
    const deps = depsFor({ ...DEFAULT_CONFIG });
    await expect(statusCommand(deps)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(syncCommand(deps)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(publishCommand(deps, { path: 'a.md', makePublic: true })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('sync pushes local notes', async () => {
    const { vaultDir, cfg } = await setup();
    const pds = new FakePds();
    await fs.writeFile(path.join(vaultDir, 'a.md'), 'hello');
    const r = await syncCommand(depsFor(cfg, pds));
    expect(r.ok).toBe(true);
    expect((await pds.listRecords('app.notesky.note')).length).toBe(1);
  });

  it('sync waits for a lock held by another process, then succeeds', async () => {
    const { vaultDir, cfg } = await setup();
    const held = (await tryAcquireLock(vaultDir))!;
    setTimeout(() => void held.release(), 200);
    const r = await syncCommand(depsFor(cfg));
    expect(r.ok).toBe(true);
  });

  it('sync fails fast with LOCK_TIMEOUT when not waiting, and after the timeout when waiting', async () => {
    const { vaultDir, cfg } = await setup();
    const held = (await tryAcquireLock(vaultDir))!;
    await expect(syncCommand(depsFor(cfg, new FakePds(), { wait: false, timeoutMs: 0 }))).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    await expect(syncCommand(depsFor(cfg, new FakePds(), { wait: true, timeoutMs: 150 }))).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    await held.release();
  });

  it('publish makes a note public and reports no-op on repeat', async () => {
    const { vaultDir, cfg } = await setup();
    const pds = new FakePds();
    await fs.writeFile(path.join(vaultDir, 'post.md'), 'hello world');
    const deps = depsFor(cfg, pds);
    const r = await publishCommand(deps, { path: 'post.md', makePublic: true, slug: 'hello' });
    expect(r).toMatchObject({ ok: true, path: 'post.md', published: true, changed: true });
    expect(JSON.stringify(await pds.listRecords('app.notesky.note'))).toContain('hello world');
    const again = await publishCommand(deps, { path: 'post.md', makePublic: true });
    expect(again.changed).toBe(false);
  });

  it('status works offline and reports the daemon as not running', async () => {
    const { cfg } = await setup();
    const deps: CommandDeps = { ...depsFor(cfg), connect: async () => { throw new Error('offline'); } };
    const r = await statusCommand(deps);
    expect(r).toMatchObject({ ok: true, remote: null, remoteError: 'offline', daemon: { running: false, pid: null } });
    const text = renderStatus(r);
    expect(text).toContain('daemon: not running');
    expect(text).toContain('remote: unavailable (offline)');
  });

  it('sync and status retry once with a fresh session after a 401 from the PDS', async () => {
    const { vaultDir, cfg } = await setup();
    await fs.writeFile(path.join(vaultDir, 'a.md'), 'hello');
    const pds = new FakePds();
    const dead = new FakePds();
    const expired = Object.assign(new Error('Token has expired'), { status: 401, error: 'ExpiredToken' });
    dead.listRecords = async () => {
      throw expired;
    };
    let connects = 0;
    const deps: CommandDeps = {
      ...depsFor(cfg, pds),
      connect: async () => ({ pds: connects++ === 0 ? dead : pds, did: 'did:plc:me', pdsUrl: 'http://fake' }),
    };
    expect((await syncCommand(deps)).ok).toBe(true);
    expect(connects).toBe(2);
    connects = 0;
    const st = await statusCommand(deps);
    expect(st.remote).toEqual({ notes: 1, attachments: 0 });
    expect(connects).toBe(2);
  });

  it('status ignores daemon.json written by another machine sharing the folder', async () => {
    const { vaultDir, cfg } = await setup();
    const foreign = {
      pid: process.ppid, host: 'some-other-host', startedAt: 'x', connection: 'subscribed',
      lastSyncAt: '2020-01-01T00:00:00.000Z', lastResult: 'error', lastError: 'their error', lastExit: 'their exit',
    };
    await fs.mkdir(path.dirname(daemonStatePath(vaultDir)), { recursive: true });
    await fs.writeFile(daemonStatePath(vaultDir), JSON.stringify(foreign));
    const stopped = await statusCommand(depsFor(cfg));
    expect(stopped.daemon).toEqual({ running: false, pid: null, connection: null, lastSyncAt: null, lastError: null, lastExit: null });

    // A daemon runs here, but daemon.json names another pid: still not ours.
    await writePidExclusive(process.ppid);
    await fs.writeFile(daemonStatePath(vaultDir), JSON.stringify({ ...foreign, host: os.hostname(), pid: process.pid }));
    const running = await statusCommand(depsFor(cfg));
    expect(running.daemon).toMatchObject({ running: true, pid: process.ppid, connection: null, lastError: null });

    await fs.writeFile(daemonStatePath(vaultDir), JSON.stringify({ ...foreign, host: os.hostname() }));
    expect((await statusCommand(depsFor(cfg))).daemon).toMatchObject({ running: true, connection: 'subscribed', lastError: 'their error' });
  });

  it('never exposes the app password or master key', async () => {
    const { cfg } = await setup();
    const r = await statusCommand(depsFor(cfg));
    const json = JSON.stringify(r) + renderStatus(r);
    expect(json).not.toContain(cfg.appPassword);
    expect(json).not.toContain(cfg.masterKeyB64);
  });
});
