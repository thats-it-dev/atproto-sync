import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { FakePds } from '@atproto-sync/core/sync/fake-pds';
import { main, type CliEnv } from '../src/cli';
import { AtpsyncError } from '../src/errors';
import { DEFAULT_CONFIG, loadConfig, saveConfig, type AtpsyncConfig } from '../src/config';
import { tryAcquireLock } from '../src/lock';
import { stopCommand } from '../src/commands/daemon-control';
import { isAlive, readLivePid } from '../src/pidfile';
import { clearAtpsyncEnv, configuredCfg, tempEnv } from './helpers';

afterEach(clearAtpsyncEnv);

function env(cfg: AtpsyncConfig, pds = new FakePds()) {
  const out: string[] = [];
  const err: string[] = [];
  const e: CliEnv = {
    io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
    deps: {
      loadConfig: async () => cfg,
      connect: async () => ({ pds, did: 'did:plc:me', pdsUrl: 'http://fake' }),
      lock: { wait: true, timeoutMs: 500 },
    },
    ctl: { execPath: process.execPath, cliPath: '/nonexistent' },
    cwd: process.cwd(),
  };
  return { e, out, err };
}

describe('main', () => {
  it('help exits 0', async () => {
    const { e, out } = env({ ...DEFAULT_CONFIG });
    expect(await main(['help'], e)).toBe(0);
    expect(out.join('')).toContain('atpsync start');
  });

  it('unknown command and unknown flag exit 2', async () => {
    const { e } = env({ ...DEFAULT_CONFIG });
    expect(await main(['frobnicate'], e)).toBe(2);
    expect(await main(['status', '--bogus'], e)).toBe(2);
  });

  it('status --json before setup prints a JSON error and exits 3', async () => {
    await tempEnv();
    const { e, out } = env({ ...DEFAULT_CONFIG });
    expect(await main(['status', '--json'], e)).toBe(3);
    const parsed = JSON.parse(out.join(''));
    expect(parsed).toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED' } });
  });

  it('sync --json prints the summary', async () => {
    const { vaultDir } = await tempEnv();
    const cfg = await configuredCfg(vaultDir);
    await saveConfig(cfg);
    await fs.writeFile(path.join(vaultDir, 'a.md'), 'x');
    const { e, out } = env(cfg);
    expect(await main(['sync', '--json'], e)).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: true, vaultDir });
  });

  it('sync --no-wait exits 4 while another process holds the lock', async () => {
    const { vaultDir } = await tempEnv();
    const cfg = await configuredCfg(vaultDir);
    const held = (await tryAcquireLock(vaultDir))!;
    const { e, err } = env(cfg);
    expect(await main(['sync', '--no-wait'], e)).toBe(4);
    expect(err.join('')).toMatch(/Another atpsync process/);
    await held.release();
  });

  it('publish without a path is a usage error', async () => {
    const { vaultDir } = await tempEnv();
    const { e } = env(await configuredCfg(vaultDir));
    expect(await main(['publish'], e)).toBe(2);
  });

  it('logout clears credentials but keeps the vault binding', async () => {
    const { vaultDir } = await tempEnv();
    const cfg = await configuredCfg(vaultDir);
    await saveConfig(cfg);
    const { e } = env(cfg);
    e.deps.loadConfig = loadConfig;
    expect(await main(['logout', '--json'], e)).toBe(0);
    const saved = await loadConfig();
    expect(saved.appPassword).toBe('');
    expect(saved.masterKeyB64).toBe('');
    expect(saved.vaultDir).toBe(vaultDir);
  });

  describe('setup with a running daemon', () => {
    // Stand-in for `atpsync daemon`: claims the pidfile and daemon.json, exits on SIGTERM.
    const STUB = `
      const fs = require('fs'), os = require('os'), path = require('path');
      const st = process.env.ATPSYNC_STATE_DIR, vault = process.env.ATPSYNC_VAULT_DIR;
      fs.mkdirSync(st, { recursive: true });
      fs.writeFileSync(path.join(st, 'daemon.pid'), String(process.pid));
      fs.mkdirSync(path.join(vault, '.atpsync'), { recursive: true });
      fs.writeFileSync(path.join(vault, '.atpsync', 'daemon.json'), JSON.stringify({ pid: process.pid, host: os.hostname() }));
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1e6);
    `;

    async function running() {
      const { root, vaultDir } = await tempEnv();
      process.env.ATPSYNC_VAULT_DIR = vaultDir;
      const cfg = await configuredCfg(vaultDir);
      await saveConfig(cfg);
      const stub = path.join(root, 'stub-daemon.cjs');
      await fs.writeFile(stub, STUB);
      const { e, out, err } = env(cfg);
      e.ctl = { execPath: process.execPath, cliPath: stub, waitMs: 5000 };
      expect(await main(['start'], e)).toBe(0);
      const pid = (await readLivePid())!;
      expect(isAlive(pid)).toBe(true);
      return { e, out, err, pid };
    }

    it('stops the daemon, runs setup, and starts it again', async () => {
      const { e, out, pid } = await running();
      let daemonDuringSetup: number | null = -1;
      e.setup = async () => {
        daemonDuringSetup = await readLivePid();
      };
      try {
        expect(await main(['setup'], e)).toBe(0);
        expect(daemonDuringSetup).toBeNull();
        expect(isAlive(pid)).toBe(false);
        const next = await readLivePid();
        expect(next).not.toBeNull();
        expect(next).not.toBe(pid);
        expect(out.join('')).toContain(`restarted (pid ${next})`);
      } finally {
        await stopCommand({ graceMs: 2000 });
      }
    });

    it('does not restart the daemon when setup fails', async () => {
      const { e, pid } = await running();
      e.setup = async () => {
        throw new AtpsyncError('AUTH', 'Sign-in failed');
      };
      try {
        expect(await main(['setup'], e)).toBe(5);
        expect(isAlive(pid)).toBe(false);
        expect(await readLivePid()).toBeNull();
      } finally {
        await stopCommand({ graceMs: 2000 });
      }
    });
  });
});
