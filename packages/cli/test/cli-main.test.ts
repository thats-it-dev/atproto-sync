import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { FakePds } from '@atproto-sync/core/sync/fake-pds';
import { main, type CliEnv } from '../src/cli';
import { DEFAULT_CONFIG, loadConfig, saveConfig, type AtpsyncConfig } from '../src/config';
import { tryAcquireLock } from '../src/lock';
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
});
