import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { FakePds } from '@atproto-sync/core/sync/fake-pds';
import { DEFAULT_CONFIG, loadConfig, saveConfig, configPath } from '../src/config';
import { AtpsyncError } from '../src/errors';
import { clearConnectionCache, connect, getVaultStatus, runSync, withAuthRetry } from '../src/session';
import { clearAtpsyncEnv, configuredCfg, tempEnv } from './helpers';

afterEach(() => {
  clearAtpsyncEnv();
  clearConnectionCache();
});

describe('config defaults', () => {
  it('new configs subscribe and poll every minute; old files keep their interval', async () => {
    await tempEnv();
    expect(DEFAULT_CONFIG.remote).toBe('subscribe');
    expect(DEFAULT_CONFIG.syncIntervalMinutes).toBe(1);
    await fs.mkdir(path.dirname(configPath()), { recursive: true });
    await fs.writeFile(configPath(), JSON.stringify({ identifier: 'old.test', syncIntervalMinutes: 5 }));
    const cfg = await loadConfig();
    expect(cfg.remote).toBe('subscribe');
    expect(cfg.syncIntervalMinutes).toBe(5);
  });
});

describe('connect', () => {
  it('maps a 401 login failure to AUTH without leaking the password', async () => {
    const { vaultDir } = await tempEnv();
    const cfg = await configuredCfg(vaultDir, { pdsUrlOverride: 'http://pds.test' });
    const err = Object.assign(new Error('Invalid identifier or password'), { status: 401, error: 'AuthenticationRequired' });
    const p = connect(cfg, { login: async () => { throw err; } });
    await expect(p).rejects.toMatchObject({ code: 'AUTH' });
    await expect(p).rejects.not.toThrow(/app-pw-SECRET/);
  });

  it('uses the override URL and exposes the session DID', async () => {
    const { vaultDir } = await tempEnv();
    const cfg = await configuredCfg(vaultDir, { pdsUrlOverride: 'http://pds.test' });
    const pds = Object.assign(new FakePds(), { did: 'did:plc:me' });
    let resolved = 0;
    const c = await connect(cfg, {
      login: async (opts) => {
        expect(opts.pdsUrl).toBe('http://pds.test');
        return pds as never;
      },
      resolvePdsUrl: async () => {
        resolved++;
        return { did: 'x', pdsUrl: 'y' };
      },
    });
    expect(c).toMatchObject({ did: 'did:plc:me', pdsUrl: 'http://pds.test' });
    expect(resolved).toBe(0);
  });

  it('caches the session, but signs in afresh once the app password changes', async () => {
    const { vaultDir } = await tempEnv();
    const cfg = await configuredCfg(vaultDir, { pdsUrlOverride: 'http://pds.test' });
    const passwords: string[] = [];
    const login = async (opts: { password: string }) => {
      passwords.push(opts.password);
      return Object.assign(new FakePds(), { did: 'did:plc:me' }) as never;
    };
    const a = await connect(cfg, { login });
    expect(await connect(cfg, { login })).toBe(a);
    const b = await connect({ ...cfg, appPassword: 'rotated-pw' }, { login });
    expect(b).not.toBe(a);
    expect(passwords).toEqual(['app-pw-SECRET', 'rotated-pw']);
  });

  it('withAuthRetry drops a dead cached session and retries once on a 401', async () => {
    const { vaultDir } = await tempEnv();
    const cfg = await configuredCfg(vaultDir, { pdsUrlOverride: 'http://pds.test' });
    let logins = 0;
    const login = async () => {
      logins++;
      return Object.assign(new FakePds(), { did: 'did:plc:me' }) as never;
    };
    await connect(cfg, { login });
    const expired = Object.assign(new Error('Token has expired'), { status: 400, error: 'ExpiredToken' });
    const seen: number[] = [];
    const r = await withAuthRetry(async (n) => {
      seen.push(n);
      await connect(cfg, { login });
      if (n === 0) throw expired;
      return 'ok';
    });
    expect(r).toBe('ok');
    expect(seen).toEqual([0, 1]);
    expect(logins).toBe(2);
    // A rejected fresh sign-in is definitive: no second attempt.
    let calls = 0;
    await expect(
      withAuthRetry(async () => {
        calls++;
        throw new AtpsyncError('AUTH', 'Sign-in failed');
      })
    ).rejects.toMatchObject({ code: 'AUTH' });
    expect(calls).toBe(1);
  });

  it('resolves the PDS URL from the handle when there is no override', async () => {
    const { vaultDir } = await tempEnv();
    const cfg = await configuredCfg(vaultDir);
    const c = await connect(cfg, {
      login: async () => Object.assign(new FakePds(), { did: 'did:plc:me' }) as never,
      resolvePdsUrl: async () => ({ did: 'did:plc:me', pdsUrl: 'https://pds.example' }),
    });
    expect(c.pdsUrl).toBe('https://pds.example');
  });
});

describe('getVaultStatus', () => {
  it('still answers when the PDS is unreachable', async () => {
    const { vaultDir } = await tempEnv();
    await fs.writeFile(path.join(vaultDir, 'a.md'), 'x');
    const cfg = await configuredCfg(vaultDir);
    const st = await getVaultStatus(cfg, async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    expect(st.localNotes).toBe(1);
    expect(st.remote).toBeNull();
    expect(st.remoteError).toMatch(/ENOTFOUND/);
  });

  it('counts remote records for this vault', async () => {
    const { vaultDir } = await tempEnv();
    const cfg = await configuredCfg(vaultDir);
    await saveConfig(cfg);
    const pds = new FakePds();
    await fs.writeFile(path.join(vaultDir, 'a.md'), 'x');
    await runSync(cfg, { pds });
    const st = await getVaultStatus(cfg, async () => ({ pds, did: 'did:plc:me', pdsUrl: 'http://fake' }));
    expect(st.remote).toEqual({ notes: 1, attachments: 0 });
    expect(st.pdsUrl).toBe('http://fake');
  });
});

describe('not configured', () => {
  it('runSync throws NOT_CONFIGURED', async () => {
    await tempEnv();
    await expect(runSync({ ...DEFAULT_CONFIG }, { pds: new FakePds() })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });
});
