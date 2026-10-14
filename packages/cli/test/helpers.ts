import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { toB64 } from '@atproto-sync/core/crypto/box';
import { DEFAULT_CONFIG, type AtpsyncConfig } from '../src/config';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fresh temp root; points ATPSYNC_CONFIG_DIR and ATPSYNC_STATE_DIR inside it. */
export async function tempEnv(): Promise<{ root: string; vaultDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atpsync-'));
  process.env.ATPSYNC_CONFIG_DIR = path.join(root, 'config');
  process.env.ATPSYNC_STATE_DIR = path.join(root, 'state');
  const vaultDir = path.join(root, 'vault');
  await fs.mkdir(vaultDir, { recursive: true });
  return { root, vaultDir };
}

export async function configuredCfg(vaultDir: string, extra: Partial<AtpsyncConfig> = {}): Promise<AtpsyncConfig> {
  return {
    ...DEFAULT_CONFIG,
    identifier: 'me.test',
    appPassword: 'app-pw-SECRET',
    vaultRkey: 'vault1',
    masterKeyB64: await toB64(new Uint8Array(32).fill(3)),
    vaultDir,
    remote: 'poll',
    ...extra,
  };
}

export function clearAtpsyncEnv(): void {
  for (const k of Object.keys(process.env)) if (k.startsWith('ATPSYNC_')) delete process.env[k];
}

/** Poll `cond` until true or `ms` elapses. */
export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(25);
  }
  throw new Error('waitFor timed out');
}
