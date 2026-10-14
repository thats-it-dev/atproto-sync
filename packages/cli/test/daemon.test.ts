import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { encode } from 'cborg';
import { WebSocketServer } from 'ws';
import { FakePds } from '@atproto-sync/core/sync/fake-pds';
import { saveConfig, type AtpsyncConfig } from '../src/config';
import { runDaemon, type DaemonDeps } from '../src/daemon';
import { readDaemonState } from '../src/daemon-state';
import { pidPath, stateDir } from '../src/paths';
import { runSync } from '../src/session';
import { createFileLogger } from '../src/logger';
import { clearAtpsyncEnv, configuredCfg, tempEnv, waitFor } from './helpers';

afterEach(clearAtpsyncEnv);

describe('createFileLogger', () => {
  it('appends timestamped lines and rolls over once past maxBytes', async () => {
    const { root } = await tempEnv();
    const file = path.join(root, 'state', 'daemon.log');
    const log = createFileLogger(file, { maxBytes: 100 });
    log.info('hello');
    expect(await fs.readFile(file, 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT.* INFO hello\n$/);
    log.rotateIfNeeded();
    await expect(fs.access(`${file}.1`)).rejects.toThrow(); // still small
    for (let i = 0; i < 10; i++) log.warn('x'.repeat(20));
    log.rotateIfNeeded();
    expect((await fs.readFile(`${file}.1`, 'utf8')).length).toBeGreaterThan(100);
    log.error('after');
    expect(await fs.readFile(file, 'utf8')).toMatch(/ERROR after/);
  });
});

const FAST = { startup: 0, fs: 50, remote: 20, poll: 0 };

function harness(cfg: AtpsyncConfig, connect: DaemonDeps['connect']) {
  const signals = new EventEmitter();
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(`I ${m}`), warn: (m: string) => logs.push(`W ${m}`), error: (m: string) => logs.push(`E ${m}`) };
  const deps: DaemonDeps = {
    loadConfig: async () => cfg,
    connect,
    clearConnection: () => {},
    log,
    signals,
    debounceMs: FAST,
    subscriptionBackoffMs: { min: 20, max: 40 },
  };
  return { deps, signals, logs };
}

describe('runDaemon', () => {
  it('claims the pidfile, syncs on startup and on file changes, and shuts down cleanly', async () => {
    const { vaultDir } = await tempEnv();
    const cfg = await configuredCfg(vaultDir);
    await saveConfig(cfg);
    const pds = new FakePds();
    await fs.writeFile(path.join(vaultDir, 'a.md'), 'first');
    const { deps, signals } = harness(cfg, async () => ({ pds, did: 'did:plc:me', pdsUrl: 'http://fake' }));

    const done = runDaemon(deps);
    await waitFor(async () => (await pds.listRecords('app.notesky.note')).length === 1);
    expect((await fs.readFile(pidPath(), 'utf8')).trim()).toBe(String(process.pid));
    await waitFor(async () => (await readDaemonState(vaultDir))?.lastResult === 'ok');

    await fs.writeFile(path.join(vaultDir, 'b.md'), 'second');
    await waitFor(async () => (await pds.listRecords('app.notesky.note')).length === 2);

    signals.emit('SIGTERM', 'SIGTERM');
    await done;
    await expect(fs.access(pidPath())).rejects.toThrow();
    expect((await readDaemonState(vaultDir))?.lastExit).toMatch(/^stopped/);
    await expect(fs.access(path.join(vaultDir, '.atpsync', 'lock'))).rejects.toThrow();
  });

  it('refuses to start when another live daemon holds the pidfile', async () => {
    const { vaultDir } = await tempEnv();
    const cfg = await configuredCfg(vaultDir);
    await fs.mkdir(stateDir(), { recursive: true });
    await fs.writeFile(pidPath(), String(process.ppid));
    const { deps } = harness(cfg, async () => { throw new Error('unused'); });
    await expect(runDaemon(deps)).rejects.toMatchObject({ code: 'ALREADY_RUNNING' });
  });

  it('stays up while the PDS is unreachable and recovers when it comes back', async () => {
    const { vaultDir } = await tempEnv();
    const cfg = await configuredCfg(vaultDir);
    await saveConfig(cfg);
    const pds = new FakePds();
    let online = false;
    const { deps, signals } = harness(cfg, async () => {
      if (!online) throw new Error('connect ECONNREFUSED');
      return { pds, did: 'did:plc:me', pdsUrl: 'http://fake' };
    });
    const done = runDaemon(deps);
    await waitFor(async () => (await readDaemonState(vaultDir))?.lastError === 'connect ECONNREFUSED');
    expect((await readDaemonState(vaultDir))?.lastResult).toBe('error');

    online = true;
    await fs.writeFile(path.join(vaultDir, 'a.md'), 'x');
    await waitFor(async () => (await readDaemonState(vaultDir))?.lastResult === 'ok');
    expect((await readDaemonState(vaultDir))?.lastError).toBeNull();
    signals.emit('SIGTERM', 'SIGTERM');
    await done;
  });

  it('pulls a remote change as soon as the event stream reports it', async () => {
    const { root, vaultDir } = await tempEnv();
    const cfg = await configuredCfg(vaultDir, { remote: 'subscribe' });
    await saveConfig(cfg);
    const pds = new FakePds();
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const pdsUrl = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    const { deps, signals } = harness(cfg, async () => ({ pds, did: 'did:plc:me', pdsUrl }));
    // Long poll so only the stream can explain a quick pull.
    deps.subscribedPollMs = 60 * 60_000;
    const connected = new Promise<import('ws').WebSocket>((r) => wss.once('connection', (s) => r(s)));

    const done = runDaemon(deps);
    const sock = await connected;
    await waitFor(async () => (await readDaemonState(vaultDir))?.connection === 'subscribed');
    await waitFor(async () => (await readDaemonState(vaultDir))?.lastResult === 'ok');

    // Device B writes a note straight to the PDS.
    const dirB = path.join(root, 'deviceB');
    await fs.mkdir(dirB);
    await fs.writeFile(path.join(dirB, 'from-b.md'), 'hello from B');
    await runSync({ ...cfg, vaultDir: dirB }, { pds });

    const h = encode({ op: 1, t: '#commit' });
    const b = encode({ repo: 'did:plc:me', ops: [{ action: 'create', path: 'app.notesky.note/x', cid: null }] });
    sock.send(Buffer.concat([h, b]));
    await waitFor(async () => {
      try {
        return (await fs.readFile(path.join(vaultDir, 'from-b.md'), 'utf8')) === 'hello from B';
      } catch {
        return false;
      }
    }, 3000);

    signals.emit('SIGTERM', 'SIGTERM');
    await done;
    await new Promise<void>((r) => wss.close(() => r()));
  });
});
