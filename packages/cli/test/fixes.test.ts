import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FakePds } from '@atproto-sync/core/sync/fake-pds';
import { toB64 } from '@atproto-sync/core/crypto/box';
import { DEFAULT_CONFIG, DEFAULT_IGNORES, loadConfig, saveConfig, boundVaultDir } from '../src/config';
import { runSync, togglePublic } from '../src/session';
import { runSetup, createVault, unlockVault, type SetupIO } from '../src/setup';
import { FsVaultAdapter } from '../src/fs-vault';

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'atpsync-fix-'));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('ATPSYNC_')) delete process.env[k];
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freshConfigDir(): Promise<string> {
  const d = path.join(await fs.mkdtemp(path.join(tmp, 'cfg-')), 'atpsync');
  process.env.ATPSYNC_CONFIG_DIR = d;
  return d;
}

async function configuredCfg(vaultDir: string) {
  return {
    ...DEFAULT_CONFIG,
    identifier: 'me.test',
    appPassword: 'pw',
    vaultRkey: 'vault1',
    masterKeyB64: await toB64(new Uint8Array(32).fill(3)),
    vaultDir,
  };
}

describe('vault directory binding', () => {
  it('boundVaultDir refuses to fall back to the cwd', async () => {
    const cfg = { ...DEFAULT_CONFIG };
    expect(() => boundVaultDir(cfg)).toThrow(/ATPSYNC_VAULT_DIR|setup/);
    expect(boundVaultDir({ ...cfg, vaultDir: '/v' })).toBe('/v');
    expect(boundVaultDir(cfg, '/explicit')).toBe('/explicit');
    process.env.ATPSYNC_VAULT_DIR = '/env';
    expect(boundVaultDir(cfg)).toBe('/env');
  });

  it('runSync refuses when no vault dir is bound', async () => {
    await freshConfigDir();
    const cfg = await configuredCfg('');
    await expect(runSync(cfg, { pds: new FakePds() })).rejects.toThrow(/ATPSYNC_VAULT_DIR|setup/);
  });

  it('default ignores include node_modules', () => {
    expect(DEFAULT_IGNORES).toContain('node_modules/');
  });
});

describe('runSync', () => {
  it('persists lastSyncAt to the config after a successful sync', async () => {
    await freshConfigDir();
    const dir = await fs.mkdtemp(path.join(tmp, 'rs-'));
    const cfg = await configuredCfg(dir);
    await saveConfig(cfg);
    await fs.writeFile(path.join(dir, 'a.md'), 'x');
    const summary = await runSync(cfg, { pds: new FakePds() });
    expect(summary.vaultDir).toBe(dir);
    const saved = await loadConfig();
    expect(saved.lastSyncAt).toBe(summary.lastSyncAt);
  });
});

describe('togglePublic', () => {
  it('rejects paths that escape the vault', async () => {
    await freshConfigDir();
    const dir = await fs.mkdtemp(path.join(tmp, 'tp-'));
    const cfg = await configuredCfg(dir);
    await expect(togglePublic(cfg, '../outside.md', true, undefined, { pds: new FakePds() })).rejects.toThrow(/Unsafe/);
  });

  it('rejects non-markdown paths', async () => {
    await freshConfigDir();
    const dir = await fs.mkdtemp(path.join(tmp, 'tp2-'));
    const cfg = await configuredCfg(dir);
    await fs.writeFile(path.join(dir, 'pic.png'), 'x');
    await expect(togglePublic(cfg, 'pic.png', true, undefined, { pds: new FakePds() })).rejects.toThrow(/markdown/i);
  });

  it('publishes a note and syncs it as plaintext', async () => {
    await freshConfigDir();
    const dir = await fs.mkdtemp(path.join(tmp, 'tp3-'));
    const cfg = await configuredCfg(dir);
    await fs.writeFile(path.join(dir, 'post.md'), 'hello world');
    const pds = new FakePds();
    const r = await togglePublic(cfg, 'post.md', true, 'hello', { pds });
    expect(r.changed).toBe(true);
    expect(r.message).toMatch(/now public/);
    expect(JSON.stringify(await pds.listRecords('app.notesky.note'))).toContain('hello world');
  });
});

describe('runSetup vault folder', () => {
  function headlessIO(cwd: string, vaultDir?: string): SetupIO & { notices: string[] } {
    const notices: string[] = [];
    return {
      cwd,
      hasUI: false,
      vaultDir,
      notices,
      input: async () => undefined,
      select: async () => undefined,
      notify: (m) => notices.push(m),
    };
  }

  function headlessEnv(pass = 'hunter2') {
    process.env.ATPSYNC_HANDLE = 'me.test';
    process.env.ATPSYNC_APP_PASSWORD = 'pw';
    process.env.ATPSYNC_PASSPHRASE = pass;
  }

  it('binds the folder given as the setup argument, creating it if missing', async () => {
    await freshConfigDir();
    const cwd = await fs.mkdtemp(path.join(tmp, 'su-'));
    const target = path.join(cwd, 'new', 'vault');
    headlessEnv();
    const pds = new FakePds();
    await runSetup(headlessIO(cwd, target), { login: async () => pds });
    const cfg = await loadConfig();
    expect(cfg.identifier).toBe('me.test');
    expect(cfg.vaultRkey).not.toBe('');
    expect(cfg.vaultDir).toBe(target);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
    const unlocked = await unlockVault(pds, cfg.vaultRkey, 'hunter2');
    expect(unlocked.masterKeyB64).toBe(cfg.masterKeyB64);
  });

  it('resolves a relative setup argument against the cwd and expands ~', async () => {
    await freshConfigDir();
    const cwd = await fs.mkdtemp(path.join(tmp, 'su-rel-'));
    headlessEnv();
    await runSetup(headlessIO(cwd, 'notes'), { login: async () => new FakePds() });
    expect((await loadConfig()).vaultDir).toBe(path.join(cwd, 'notes'));

    await freshConfigDir();
    await runSetup(headlessIO(cwd, '~'), { login: async () => new FakePds() });
    expect((await loadConfig()).vaultDir).toBe(os.homedir());
  });

  it('falls back to ATPSYNC_VAULT_DIR when headless and no argument is given', async () => {
    await freshConfigDir();
    const cwd = await fs.mkdtemp(path.join(tmp, 'su-env-'));
    const target = path.join(cwd, 'from-env');
    headlessEnv();
    process.env.ATPSYNC_VAULT_DIR = target;
    await runSetup(headlessIO(cwd), { login: async () => new FakePds() });
    expect((await loadConfig()).vaultDir).toBe(target);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });

  it('never silently binds the cwd: headless with no folder anywhere is an error', async () => {
    await freshConfigDir();
    const cwd = await fs.mkdtemp(path.join(tmp, 'su-none-'));
    headlessEnv();
    await expect(runSetup(headlessIO(cwd), { login: async () => new FakePds() })).rejects.toThrow(/ATPSYNC_VAULT_DIR|setup <dir>/);
    expect((await loadConfig()).vaultRkey).toBe('');
  });

  it('refuses a path that exists but is not a directory', async () => {
    await freshConfigDir();
    const cwd = await fs.mkdtemp(path.join(tmp, 'su-file-'));
    const file = path.join(cwd, 'a-file');
    await fs.writeFile(file, 'x');
    headlessEnv();
    await expect(runSetup(headlessIO(cwd, file), { login: async () => new FakePds() })).rejects.toThrow(/not a directory/i);
  });

  it('joins an existing vault when ATPSYNC_VAULT_RKEY is set', async () => {
    await freshConfigDir();
    const cwd = await fs.mkdtemp(path.join(tmp, 'su2-'));
    const pds = new FakePds();
    const existing = await createVault(pds, 'Old', 'hunter2');
    headlessEnv();
    process.env.ATPSYNC_VAULT_RKEY = existing.vaultRkey;
    await runSetup(headlessIO(cwd, cwd), { login: async () => pds });
    const cfg = await loadConfig();
    expect(cfg.vaultRkey).toBe(existing.vaultRkey);
    expect(cfg.masterKeyB64).toBe(existing.masterKeyB64);
    expect((await pds.listRecords('app.notesky.vault')).length).toBe(1);
  });

  function uiIO(cwd: string, answers: Record<string, string | undefined>): SetupIO & { prompts: string[] } {
    const prompts: string[] = [];
    return {
      cwd,
      hasUI: true,
      prompts,
      input: async (title) => {
        prompts.push(title);
        const key = Object.keys(answers).find((k) => title.toLowerCase().includes(k));
        return key ? answers[key] : undefined;
      },
      select: async () => undefined,
      notify: () => {},
    };
  }

  it('interactive: prompts for the folder and binds the answer', async () => {
    await freshConfigDir();
    const cwd = await fs.mkdtemp(path.join(tmp, 'su-ui-'));
    const target = path.join(cwd, 'picked');
    await runSetup(
      uiIO(cwd, { handle: 'me.test', 'app password': 'pw', folder: target, passphrase: 'hunter2', name: 'V' }),
      { login: async () => new FakePds() }
    );
    expect((await loadConfig()).vaultDir).toBe(target);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });

  it('interactive: an empty answer takes the default, which is the cwd on first setup', async () => {
    await freshConfigDir();
    const cwd = await fs.mkdtemp(path.join(tmp, 'su-ui-def-'));
    const io = uiIO(cwd, { handle: 'me.test', 'app password': 'pw', folder: '', passphrase: 'hunter2', name: 'V' });
    await runSetup(io, { login: async () => new FakePds() });
    expect((await loadConfig()).vaultDir).toBe(cwd);
    expect(io.prompts.find((p) => p.toLowerCase().includes('folder'))).toContain(cwd);
  });

  it('interactive: the default is the previously bound folder on re-setup', async () => {
    await freshConfigDir();
    const cwd = await fs.mkdtemp(path.join(tmp, 'su-ui-prev-'));
    const prev = path.join(cwd, 'prev');
    await saveConfig({ ...DEFAULT_CONFIG, vaultDir: prev });
    const io = uiIO(cwd, { handle: 'me.test', 'app password': 'pw', folder: '', passphrase: 'hunter2', name: 'V' });
    await runSetup(io, { login: async () => new FakePds() });
    expect((await loadConfig()).vaultDir).toBe(prev);
    expect(io.prompts.find((p) => p.toLowerCase().includes('folder'))).toContain(prev);
  });

  it('interactive: the argument skips the folder prompt', async () => {
    await freshConfigDir();
    const cwd = await fs.mkdtemp(path.join(tmp, 'su-ui-arg-'));
    const io = uiIO(cwd, { handle: 'me.test', 'app password': 'pw', passphrase: 'hunter2', name: 'V' });
    io.vaultDir = path.join(cwd, 'arg');
    await runSetup(io, { login: async () => new FakePds() });
    expect((await loadConfig()).vaultDir).toBe(path.join(cwd, 'arg'));
    expect(io.prompts.some((p) => p.toLowerCase().includes('folder'))).toBe(false);
  });
});

describe('runSetup sign-in', () => {
  function io(hasUI: boolean, answers: Record<string, string> = {}): SetupIO & { prompts: string[] } {
    const prompts: string[] = [];
    return {
      cwd: tmp,
      hasUI,
      prompts,
      input: async (title) => {
        prompts.push(title);
        const key = Object.keys(answers).find((k) => title.toLowerCase().startsWith(k));
        return key ? answers[key] : undefined;
      },
      select: async () => undefined,
      notify: () => {},
    };
  }
  const rejected = () => Object.assign(new Error('Invalid identifier or password'), { status: 401, error: 'AuthenticationRequired' });

  it('interactive: re-prompts for a new app password when the saved one is rejected', async () => {
    await freshConfigDir();
    const dir = await fs.mkdtemp(path.join(tmp, 'su-auth-'));
    await saveConfig({ ...DEFAULT_CONFIG, identifier: 'me.test', appPassword: 'revoked-pw', vaultDir: dir });
    const tried: string[] = [];
    const pds = new FakePds();
    const ui = io(true, { 'new app password': 'fresh-pw', 'vault folder': dir, 'vault passphrase': 'hunter2', name: 'V' });
    await runSetup(ui, {
      login: async (_id, pw) => {
        tried.push(pw);
        if (pw === 'revoked-pw') throw rejected();
        return pds;
      },
    });
    expect(tried).toEqual(['revoked-pw', 'fresh-pw']);
    expect(ui.prompts.some((p) => p.startsWith('New app password'))).toBe(true);
    expect((await loadConfig()).appPassword).toBe('fresh-pw');
  });

  it('headless: uses a different ATPSYNC_APP_PASSWORD, else fails with AUTH', async () => {
    await freshConfigDir();
    const dir = await fs.mkdtemp(path.join(tmp, 'su-auth-h-'));
    await saveConfig({ ...DEFAULT_CONFIG, identifier: 'me.test', appPassword: 'revoked-pw', vaultDir: dir });
    process.env.ATPSYNC_PASSPHRASE = 'hunter2';
    const login = async (_id: string, pw: string) => {
      if (pw !== 'env-pw') throw rejected();
      return new FakePds();
    };
    await expect(runSetup(io(false), { login })).rejects.toMatchObject({ code: 'AUTH' });
    process.env.ATPSYNC_APP_PASSWORD = 'revoked-pw';
    await expect(runSetup(io(false), { login })).rejects.toMatchObject({ code: 'AUTH' });
    process.env.ATPSYNC_APP_PASSWORD = 'env-pw';
    await runSetup(io(false), { login });
    expect((await loadConfig()).appPassword).toBe('env-pw');
  });

  it('a newly entered password that is rejected fails with AUTH; missing credentials are USAGE', async () => {
    await freshConfigDir();
    process.env.ATPSYNC_HANDLE = 'me.test';
    process.env.ATPSYNC_APP_PASSWORD = 'typo-pw';
    process.env.ATPSYNC_VAULT_DIR = tmp;
    await expect(runSetup(io(false), { login: async () => { throw rejected(); } })).rejects.toMatchObject({ code: 'AUTH' });
    delete process.env.ATPSYNC_APP_PASSWORD;
    await expect(runSetup(io(false), { login: async () => new FakePds() })).rejects.toMatchObject({ code: 'USAGE' });
  });
});

describe('FsVaultAdapter walk', () => {
  it('does not descend into ignored directories', async () => {
    const dir = await fs.mkdtemp(path.join(tmp, 'walk-'));
    await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'x.js'), 'x');
    await fs.writeFile(path.join(dir, 'a.md'), 'x');
    const vault = new FsVaultAdapter(dir, () => ['node_modules/']);
    const spy = vi.spyOn(fs, 'readdir');
    try {
      await vault.readAll();
      const visited = spy.mock.calls.map((c) => String(c[0]));
      expect(visited.some((p) => p.includes('node_modules'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('FsVaultAdapter internal files', () => {
  it('never lists .atpsync/, even with an empty ignore list', async () => {
    const dir = await fs.mkdtemp(path.join(tmp, 'int-'));
    await fs.mkdir(path.join(dir, '.atpsync'));
    await fs.writeFile(path.join(dir, '.atpsync', 'index.json'), '[]');
    await fs.writeFile(path.join(dir, '.atpsync', 'notes.md'), 'x');
    await fs.writeFile(path.join(dir, 'a.md'), 'x');
    const vault = new FsVaultAdapter(dir, () => []);
    expect((await vault.readAll()).map((f) => f.path)).toEqual(['a.md']);
    expect(await vault.readAllAttachments()).toEqual([]);
    expect(await vault.countMarkdown()).toBe(1);
  });
});

describe('FsVaultAdapter attachment hash cache', () => {
  it('only retains entries for attachments that still exist', async () => {
    const dir = await fs.mkdtemp(path.join(tmp, 'hc-'));
    const vault = new FsVaultAdapter(dir, () => []);
    await fs.writeFile(path.join(dir, 'keep.bin'), 'v1');
    await fs.writeFile(path.join(dir, 'gone.bin'), 'x');
    await vault.readAllAttachments();
    expect(vault.attachmentCacheSize).toBe(2);

    await sleep(20); // ensure a distinct mtime
    await fs.writeFile(path.join(dir, 'keep.bin'), 'v2-longer');
    await fs.rm(path.join(dir, 'gone.bin'));
    const atts = await vault.readAllAttachments();
    expect(atts.map((a) => a.path)).toEqual(['keep.bin']);
    expect(vault.attachmentCacheSize).toBe(1);
  });
});
