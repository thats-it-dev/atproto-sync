import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FakePds } from '../../src/sync/fake-pds';
import { toB64 } from '../../src/crypto/box';
import { isIgnored } from '../../src/obsidian/ignore';
import { VaultWatcher } from '../../pi-extension/watcher';
import { DEFAULT_CONFIG, DEFAULT_IGNORES, loadConfig, saveConfig, boundVaultDir } from '../../pi-extension/config';
import { runSync, togglePublic } from '../../pi-extension/session';
import { runSetup, createVault, unlockVault, type SetupIO } from '../../pi-extension/setup';
import { FsVaultAdapter } from '../../pi-extension/fs-vault';

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

describe('VaultWatcher', () => {
  it("does not re-trigger itself from writes to ignored paths (the engine's own index save)", async () => {
    const root = await fs.mkdtemp(path.join(tmp, 'w-'));
    let syncs = 0;
    const w = new VaultWatcher(
      root,
      async () => {
        syncs++;
        await fs.mkdir(path.join(root, '.atpsync'), { recursive: true });
        const idx = path.join(root, '.atpsync', 'index.json');
        await fs.writeFile(`${idx}.tmp`, '[]');
        await fs.rename(`${idx}.tmp`, idx);
      },
      { debounceMs: 100, intervalMs: 60_000, ignore: (rel) => isIgnored(rel, ['.atpsync/']) }
    );
    w.start();
    await fs.writeFile(path.join(root, 'note.md'), 'hi');
    await sleep(1200);
    w.stop();
    expect(syncs).toBe(1);
  });

  it('debounces a change that arrives mid-sync instead of re-running immediately', async () => {
    const root = await fs.mkdtemp(path.join(tmp, 'w2-'));
    const starts: number[] = [];
    const ends: number[] = [];
    const w = new VaultWatcher(
      root,
      async () => {
        starts.push(Date.now());
        if (starts.length === 1) {
          // Simulate a pull writing a non-ignored note while we are syncing.
          await fs.writeFile(path.join(root, 'pulled.md'), 'from remote');
          await sleep(150);
        }
        ends.push(Date.now());
      },
      { debounceMs: 200, intervalMs: 60_000 }
    );
    w.start();
    await fs.writeFile(path.join(root, 'note.md'), 'hi');
    await sleep(1500);
    w.stop();
    expect(starts.length).toBe(2);
    expect(starts[1] - ends[0]).toBeGreaterThanOrEqual(150);
  });
});

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
    await expect(runSync(cfg, '/some/cwd', { pds: new FakePds() })).rejects.toThrow(/ATPSYNC_VAULT_DIR|setup/);
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
    const summary = await runSync(cfg, '/elsewhere', { pds: new FakePds() });
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
    await expect(togglePublic(cfg, '/cwd', '../outside.md', true, undefined, { pds: new FakePds() })).rejects.toThrow(/Unsafe/);
  });

  it('rejects non-markdown paths', async () => {
    await freshConfigDir();
    const dir = await fs.mkdtemp(path.join(tmp, 'tp2-'));
    const cfg = await configuredCfg(dir);
    await fs.writeFile(path.join(dir, 'pic.png'), 'x');
    await expect(togglePublic(cfg, '/cwd', 'pic.png', true, undefined, { pds: new FakePds() })).rejects.toThrow(/markdown/i);
  });

  it('publishes a note and syncs it as plaintext', async () => {
    await freshConfigDir();
    const dir = await fs.mkdtemp(path.join(tmp, 'tp3-'));
    const cfg = await configuredCfg(dir);
    await fs.writeFile(path.join(dir, 'post.md'), 'hello world');
    const pds = new FakePds();
    const msg = await togglePublic(cfg, '/cwd', 'post.md', true, 'hello', { pds });
    expect(msg).toMatch(/now public/);
    expect(JSON.stringify(await pds.listRecords('app.notesky.note'))).toContain('hello world');
  });
});

describe('runSetup (headless)', () => {
  function headlessIO(cwd: string): SetupIO & { notices: string[] } {
    const notices: string[] = [];
    return {
      cwd,
      hasUI: false,
      notices,
      input: async () => undefined,
      select: async () => undefined,
      notify: (m) => notices.push(m),
    };
  }

  it('reads the passphrase from ATPSYNC_PASSPHRASE, creates a vault and binds the cwd as vaultDir', async () => {
    await freshConfigDir();
    const cwd = await fs.mkdtemp(path.join(tmp, 'su-'));
    process.env.ATPSYNC_HANDLE = 'me.test';
    process.env.ATPSYNC_APP_PASSWORD = 'pw';
    process.env.ATPSYNC_PASSPHRASE = 'hunter2';
    const pds = new FakePds();
    await runSetup(headlessIO(cwd), { login: async () => pds });
    const cfg = await loadConfig();
    expect(cfg.identifier).toBe('me.test');
    expect(cfg.vaultRkey).not.toBe('');
    expect(cfg.vaultDir).toBe(cwd);
    const unlocked = await unlockVault(pds, cfg.vaultRkey, 'hunter2');
    expect(unlocked.masterKeyB64).toBe(cfg.masterKeyB64);
  });

  it('joins an existing vault when ATPSYNC_VAULT_RKEY is set', async () => {
    await freshConfigDir();
    const cwd = await fs.mkdtemp(path.join(tmp, 'su2-'));
    const pds = new FakePds();
    const existing = await createVault(pds, 'Old', 'hunter2');
    process.env.ATPSYNC_HANDLE = 'me.test';
    process.env.ATPSYNC_APP_PASSWORD = 'pw';
    process.env.ATPSYNC_PASSPHRASE = 'hunter2';
    process.env.ATPSYNC_VAULT_RKEY = existing.vaultRkey;
    await runSetup(headlessIO(cwd), { login: async () => pds });
    const cfg = await loadConfig();
    expect(cfg.vaultRkey).toBe(existing.vaultRkey);
    expect(cfg.masterKeyB64).toBe(existing.masterKeyB64);
    expect((await pds.listRecords('app.notesky.vault')).length).toBe(1);
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
