import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveConfig } from '../src/config';
import { isAlive } from '../src/pidfile';
import { pidPath, stateDir } from '../src/paths';
import { clearAtpsyncEnv, configuredCfg, tempEnv } from './helpers';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(pkgRoot, 'dist', 'atpsync.cjs');

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], { env: process.env, encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

describe('daemon lifecycle (built CLI)', () => {
  beforeAll(async () => {
    execFileSync(process.execPath, ['build.mjs'], { cwd: pkgRoot, stdio: 'ignore' });
    const { vaultDir } = await tempEnv();
    // Unreachable PDS: syncs fail, but the daemon must stay up.
    await saveConfig(await configuredCfg(vaultDir, { pdsUrlOverride: 'http://127.0.0.1:9' }));
  }, 60_000);

  afterAll(() => {
    cli(['stop']);
    clearAtpsyncEnv();
  });

  it('start → status → start again refused → stop', () => {
    const started = cli(['start', '--json']);
    expect(started.code, started.out + started.err).toBe(0);
    const { pid } = started.json();
    expect(isAlive(pid)).toBe(true);

    const st = cli(['status', '--json']);
    expect(st.code).toBe(0);
    expect(st.json()).toMatchObject({ ok: true, remote: null, daemon: { running: true, pid } });

    const again = cli(['start', '--json']);
    expect(again.code).toBe(1);
    expect(again.json()).toMatchObject({ ok: false, error: { code: 'ALREADY_RUNNING' } });

    const stopped = cli(['stop', '--json']);
    expect(stopped.code).toBe(0);
    expect(stopped.json()).toMatchObject({ ok: true, wasRunning: true, pid, forced: false });
    expect(isAlive(pid)).toBe(false);

    const after = cli(['status', '--json']);
    expect(after.json().daemon).toMatchObject({ running: false });
    expect(after.json().daemon.lastExit).toMatch(/^stopped/);
  }, 60_000);

  it('a stale pidfile does not block start', async () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    await fs.mkdir(stateDir(), { recursive: true });
    await fs.writeFile(pidPath(), String(dead));
    const started = cli(['start', '--json']);
    expect(started.code, started.out + started.err).toBe(0);
    expect(cli(['stop', '--json']).json()).toMatchObject({ wasRunning: true });
  }, 60_000);

  it('logs shows the daemon output', () => {
    const r = cli(['logs']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/daemon started/);
    expect(r.out).toMatch(/ECONNREFUSED|failed/);
  });

  it('stop when nothing is running is a no-op', () => {
    expect(cli(['stop', '--json']).json()).toMatchObject({ ok: true, wasRunning: false });
  });
});
