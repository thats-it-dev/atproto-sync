import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FakePds } from '@atproto-sync/core/sync/fake-pds';
import { SyncEngine } from '@atproto-sync/core/sync/engine';
import { FsVaultAdapter } from '../src/fs-vault';
import { FsIndexStore } from '../src/fs-store';
import { DEFAULT_CONFIG, expandVaultPath, loadConfig, saveConfig } from '../src/config';
import { createVault, listVaults, unlockVault, WrongPassphraseError } from '../src/setup';

const IGNORES = ['.obsidian/', '.atpsync/', '.git/'];

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'atpsync-pi-'));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function makeEngine(pds: FakePds, dir: string, masterKey: Uint8Array): SyncEngine {
  return new SyncEngine({
    pds,
    vault: new FsVaultAdapter(dir, () => IGNORES),
    index: new FsIndexStore(path.join(dir, '.atpsync', 'index.json')),
    masterKey,
    vaultRkey: 'test-vault',
  });
}

describe('FsVaultAdapter', () => {
  it('reads, writes, and removes markdown + binary files', async () => {
    const dir = await fs.mkdtemp(path.join(tmp, 'a-'));
    const vault = new FsVaultAdapter(dir, () => []);
    await vault.write('notes/A.md', 'hello');
    await vault.write('deep/nested/B.md', 'world');
    await fs.writeFile(path.join(dir, 'img.png'), Buffer.from([1, 2, 3]));

    const all = await vault.readAll();
    expect(all.map((f) => f.path).sort()).toEqual(['deep/nested/B.md', 'notes/A.md']);
    expect(all.find((f) => f.path === 'notes/A.md')?.content).toBe('hello');

    const atts = await vault.readAllAttachments();
    expect(atts.map((a) => a.path)).toEqual(['img.png']);
    expect(atts[0].size).toBe(3);

    await vault.writeBinary('bin/x.bin', new Uint8Array([9, 9]));
    expect(Array.from(await vault.readBinary('bin/x.bin'))).toEqual([9, 9]);

    await vault.remove('notes/A.md');
    expect((await vault.readAll()).map((f) => f.path)).toEqual(['deep/nested/B.md']);
    expect(await vault.countMarkdown()).toBe(1);
  });

  it('honors ignore patterns', async () => {
    const dir = await fs.mkdtemp(path.join(tmp, 'b-'));
    await fs.mkdir(path.join(dir, '.obsidian'), { recursive: true });
    await fs.writeFile(path.join(dir, '.obsidian', 'hidden.md'), 'x');
    await fs.writeFile(path.join(dir, 'visible.md'), 'x');
    const vault = new FsVaultAdapter(dir, () => ['.obsidian/']);
    expect((await vault.readAll()).map((f) => f.path)).toEqual(['visible.md']);
    expect((await vault.readAllAttachments()).length).toBe(0);
  });

  it('rejects path escapes', async () => {
    const dir = await fs.mkdtemp(path.join(tmp, 'c-'));
    const vault = new FsVaultAdapter(dir, () => []);
    await expect(vault.write('../outside.md', 'x')).rejects.toThrow(/Unsafe/);
  });
});

describe('FsIndexStore', () => {
  it('round-trips entries and tolerates a missing file', async () => {
    const dir = await fs.mkdtemp(path.join(tmp, 'i-'));
    const store = new FsIndexStore(path.join(dir, 'sub', 'index.json'));
    expect(await store.load()).toEqual([]);
    await store.save([
      { path: 'a.md', rkey: 'r1', baseContent: 'x', lastCid: 'c1' },
      { path: 'b.md', rkey: 'r2', baseContent: 'y', lastCid: 'c2', collection: 'app.notesky.attachment' },
    ]);
    const loaded = await store.load();
    expect(loaded).toHaveLength(2);
    expect(loaded[1].collection).toBe('app.notesky.attachment');
  });
});

describe('config', () => {
  it('saves 0600 and round-trips via ATPSYNC_CONFIG_DIR', async () => {
    const cfgDir = path.join(await fs.mkdtemp(path.join(tmp, 'cfg-')), 'atpsync');
    process.env.ATPSYNC_CONFIG_DIR = cfgDir;
    try {
      await saveConfig({ ...DEFAULT_CONFIG, identifier: 'm.bsky.social', appPassword: 'pw' });
      const cfg = await loadConfig();
      expect(cfg.identifier).toBe('m.bsky.social');
      expect(cfg.appPassword).toBe('pw');
      const st = await fs.stat(path.join(cfgDir, 'config.json'));
      expect((st.mode & 0o777) & ~0o600).toBe(0);
    } finally {
      delete process.env.ATPSYNC_CONFIG_DIR;
    }
  });

  it('expandVaultPath resolves relative paths against the cwd and expands ~', () => {
    expect(expandVaultPath('notes', '/some/cwd')).toBe('/some/cwd/notes');
    expect(expandVaultPath('/abs/dir/', '/some/cwd')).toBe('/abs/dir');
    expect(expandVaultPath('~', '/some/cwd')).toBe(os.homedir());
    expect(expandVaultPath('~/notes', '/some/cwd')).toBe(path.join(os.homedir(), 'notes'));
  });

  it('returns defaults when no config exists', async () => {
    process.env.ATPSYNC_CONFIG_DIR = path.join(await fs.mkdtemp(path.join(tmp, 'cfg-empty-')), 'atpsync');
    try {
      const cfg = await loadConfig();
      expect(cfg.identifier).toBe('');
      expect(cfg.ignorePatterns).toEqual(DEFAULT_CONFIG.ignorePatterns);
    } finally {
      delete process.env.ATPSYNC_CONFIG_DIR;
    }
  });
});

describe('setup', () => {
  it('creates a vault record and unlocks it with the same passphrase', async () => {
    const pds = new FakePds();
    const r = await createVault(pds, 'My Vault', 'hunter2');
    const vaults = await listVaults(pds);
    expect(vaults.map((v) => v.name)).toEqual(['My Vault']);
    expect(vaults[0].rkey).toBe(r.vaultRkey);
    const unlocked = await unlockVault(pds, r.vaultRkey, 'hunter2');
    expect(unlocked.masterKeyB64).toBe(r.masterKeyB64);
    expect(unlocked.vaultName).toBe('My Vault');
    await expect(unlockVault(pds, r.vaultRkey, 'wrong')).rejects.toBeInstanceOf(WrongPassphraseError);
  });
});

describe('full sync over filesystem (two devices)', () => {
  it('pushes and pulls encrypted notes and attachments', async () => {
    const pds = new FakePds();
    const master = new Uint8Array(32).fill(7);
    const dirA = await fs.mkdtemp(path.join(tmp, 'A-'));
    const dirB = await fs.mkdtemp(path.join(tmp, 'B-'));
    const a = makeEngine(pds, dirA, master);
    const b = makeEngine(pds, dirB, master);

    await fs.writeFile(path.join(dirA, 'hello.md'), 'device A edit');
    await fs.writeFile(path.join(dirA, 'pic.txt'), 'binary-ish');
    await a.sync();

    // At rest on the PDS: no plaintext.
    const raw = JSON.stringify(await pds.listRecords('app.notesky.note'));
    expect(raw).not.toContain('device A edit');
    expect(raw).not.toContain('hello.md');

    await b.sync();
    expect(await fs.readFile(path.join(dirB, 'hello.md'), 'utf8')).toBe('device A edit');
    expect(await fs.readFile(path.join(dirB, 'pic.txt'), 'utf8')).toBe('binary-ish');

    // Delete on B propagates to A.
    await fs.rm(path.join(dirB, 'hello.md'));
    await b.sync();
    await a.sync();
    await expect(fs.access(path.join(dirA, 'hello.md'))).rejects.toThrow();
  });
});
