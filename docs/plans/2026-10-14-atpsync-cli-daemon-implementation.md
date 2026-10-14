# atpsync CLI + Daemon (Phase B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `atpsync`, an agent-agnostic CLI whose self-daemonizing background process keeps a vault folder in sync with the PDS (local file changes, real-time `subscribeRepos` events, polling fallback), with `--json` output and an MCP server.

**Architecture:** Every operation is a plain async command function in `packages/cli/src/commands/` returning a typed result or throwing `AtpsyncError {code}`; the CLI (`cli.ts`) and the MCP server (`mcp.ts`) are thin renderers over the same functions. The daemon (`daemon.ts`) wires a `SyncScheduler` (one sync at a time, per-trigger debounce) to three trigger sources: a recursive fs watcher, a `RepoSubscription` websocket, and a poll timer. All writers coordinate through an O_EXCL lock file in `<vault>/.atpsync/lock`; there is no IPC.

**Tech Stack:** Node ≥ 22 (global `WebSocket`), TypeScript 7, vitest 4, esbuild (CJS bundle), `cborg` (DAG-CBOR frame decoding), `@modelcontextprotocol/sdk` 1.x + `zod` 4, `ws` (tests only).

**Spec:** `docs/plans/2026-10-14-atpsync-cli-daemon-design.md`. Prerequisite: Phase A (`docs/plans/2026-10-14-monorepo-restructure-implementation.md`) is merged — `packages/cli/src/` already contains `config.ts`, `fs-store.ts`, `fs-vault.ts`, `resolve-pds.ts`, `session.ts`, `setup.ts`, `watcher.ts`, and `packages/cli/test/{cli,fixes}.test.ts`.

## Global Constraints

- Config file: `~/.config/atpsync/config.json` (override `ATPSYNC_CONFIG_DIR`), same shape as today; new fields defaulted on load.
- State dir: `$XDG_STATE_HOME/atpsync/` (default `~/.local/state/atpsync/`, override `ATPSYNC_STATE_DIR`) holds `daemon.pid`, `daemon.log`, `daemon.log.1`.
- Per-vault files: `<vault>/.atpsync/index.json` (existing), `<vault>/.atpsync/lock`, `<vault>/.atpsync/daemon.json`.
- Debounce: `fs` 2000 ms, `remote` 500 ms, `startup`/`poll` 0 ms.
- Poll interval: 15 min while subscribed; `syncIntervalMinutes` while disconnected or in `poll` mode. New-config default `syncIntervalMinutes: 1`; existing saved values are kept.
- Lock: heartbeat 30 s; stale if same host + dead pid, or mtime older than 2 min; one-shot commands wait up to 60 s; daemon never waits.
- Reconnect backoff: 1 s → 60 s, exponential, jittered.
- `start` waits up to 3 s for the daemon; `stop` sends SIGTERM, waits 10 s, then SIGKILL.
- Log rotation: single rollover to `daemon.log.1` above 5 MB, at startup and hourly.
- Exit codes: `0` ok · `1` error · `2` usage · `3` not configured · `4` lock timeout · `5` auth failed.
- `--json` errors: `{"ok":false,"error":{"code","message"}}` on stdout.
- App password and master key never appear in logs, JSON, or MCP output.
- MCP tools: `atpsync_status`, `atpsync_sync`, `atpsync_publish {path, slug?}`, `atpsync_unpublish {path}`, `atpsync_daemon {action: "start"|"stop"}`. No setup/logout over MCP.
- User-facing strings say `atpsync <cmd>`, never `/atpsync`.

## Review Focus

1. **Laptop offline / PDS unreachable** — the daemon stays up, records `lastError` in `daemon.json`, and recovers on the next trigger once the network is back; `atpsync status` still answers (remote counts `null`). Pinned in Task 6 (status offline) and Task 7 (connect fails then succeeds).
2. **SIGKILL / reboot leaves a stale pidfile or lock** — `start` and `sync` proceed instead of refusing forever. Pinned in Task 2 (stale lock by dead pid and by mtime) and Task 9 (stale pidfile e2e).
3. **An agent rewrites many files at once** (bulk edit, `git checkout`) — this produces one sync, not one per file. Pinned in Task 3 (50-event burst → 1 run).
4. **Malformed or error websocket frames from a busy PDS** — never crash the daemon; error frames cause a reconnect. Pinned in Task 4 (garbage/truncated frames → `null`; error frame → reconnect).
5. **`atpsync sync` / MCP publish while the daemon is mid-sync** — waits and then succeeds; `--no-wait` fails with exit 4. Pinned in Task 6 (lock contention) and Task 8 (`--no-wait` exit code).

---

## File Structure

```
packages/cli/
  package.json            # + bin, build script, deps (cborg, MCP SDK, zod), devDeps (ws, @types/ws)
  build.mjs               # esbuild → dist/atpsync.cjs
  README.md               # install, commands, MCP, agent snippet
  src/
    main.ts               # process entry: main(argv) → exit code
    cli.ts                # arg parsing, dispatch, text/--json rendering, exit codes
    version.ts            # VERSION constant
    errors.ts             # AtpsyncError, ErrorCode, EXIT_CODES, toAtpsyncError
    paths.ts              # stateDir/pidPath/logPath/lockPath/daemonStatePath
    pidfile.ts            # isAlive, readLivePid, writePidExclusive, removePid
    daemon-state.ts       # DaemonState, readDaemonState, DaemonStateWriter
    lock.ts               # tryAcquireLock, acquireLock
    scheduler.ts          # SyncScheduler, Trigger
    fs-watch.ts           # watchVault (replaces watcher.ts)
    subscription.ts       # decodeFrame, isRelevantCommit, backoffDelay, RepoSubscription
    logger.ts             # Logger, createFileLogger (+ rotation)
    daemon.ts             # runDaemon
    prompts.ts            # TTY SetupIO (readline + hidden secret input)
    render.ts             # text renderers for command results
    mcp.ts                # createMcpServer, runMcp
    commands/
      context.ts          # CommandDeps, defaultDeps, requireConfig, withVaultLock
      status.ts sync.ts publish.ts daemon-control.ts logs.ts logout.ts
    config.ts session.ts setup.ts …  # from Phase A (modified in Task 5/8)
  test/
    errors-state.test.ts lock.test.ts scheduler.test.ts subscription.test.ts
    session.test.ts commands.test.ts daemon.test.ts cli-main.test.ts
    daemon.e2e.test.ts mcp.test.ts subscription-live.integration.test.ts
    cli.test.ts fixes.test.ts   # from Phase A (modified)
packages/core/src/atproto/pds-client.ts   # `did` becomes public readonly (Task 5)
```

Shared test helper used by several tasks — create it in Task 1 as `packages/cli/test/helpers.ts`:

```ts
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
```

(`remote` is added to `AtpsyncConfig` in Task 1 Step 3 so this helper typechecks from the start.)

---

### Task 1: Errors, paths, pidfile, daemon state

**Files:**
- Create: `packages/cli/src/errors.ts`, `packages/cli/src/paths.ts`, `packages/cli/src/pidfile.ts`, `packages/cli/src/daemon-state.ts`, `packages/cli/test/helpers.ts`
- Modify: `packages/cli/src/config.ts` (new `remote` field, new interval default)
- Test: `packages/cli/test/errors-state.test.ts`

**Interfaces:**
- Produces:
  - `type ErrorCode = 'ERROR' | 'USAGE' | 'NOT_CONFIGURED' | 'LOCK_TIMEOUT' | 'AUTH' | 'ALREADY_RUNNING'`
  - `class AtpsyncError extends Error { readonly code: ErrorCode }`; `EXIT_CODES: Record<ErrorCode, number>`; `toAtpsyncError(err: unknown): AtpsyncError`
  - `stateDir(): string`, `pidPath(): string`, `logPath(): string`, `lockPath(vaultDir: string): string`, `daemonStatePath(vaultDir: string): string`
  - `isAlive(pid: number): boolean`, `readLivePid(): Promise<number | null>`, `writePidExclusive(pid: number): Promise<void>`, `removePid(expected?: number): Promise<void>`
  - `interface DaemonState`, `readDaemonState(vaultDir): Promise<DaemonState | null>`, `class DaemonStateWriter { constructor(vaultDir, initial: DaemonState); readonly current: DaemonState; update(patch: Partial<DaemonState>): Promise<void> }`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/errors-state.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { AtpsyncError, EXIT_CODES, toAtpsyncError } from '../src/errors';
import { pidPath, stateDir } from '../src/paths';
import { isAlive, readLivePid, removePid, writePidExclusive } from '../src/pidfile';
import { DaemonStateWriter, readDaemonState, type DaemonState } from '../src/daemon-state';
import { clearAtpsyncEnv, tempEnv } from './helpers';

afterEach(clearAtpsyncEnv);

/** A pid that is guaranteed dead: a child that already exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid!;
}

describe('errors', () => {
  it('maps codes to the spec exit codes', () => {
    expect(EXIT_CODES).toEqual({ ERROR: 1, USAGE: 2, NOT_CONFIGURED: 3, LOCK_TIMEOUT: 4, AUTH: 5, ALREADY_RUNNING: 1 });
  });
  it('wraps unknown errors as ERROR and passes AtpsyncError through', () => {
    const e = new AtpsyncError('AUTH', 'nope');
    expect(toAtpsyncError(e)).toBe(e);
    expect(toAtpsyncError(new Error('boom'))).toMatchObject({ code: 'ERROR', message: 'boom' });
    expect(toAtpsyncError('str')).toMatchObject({ code: 'ERROR', message: 'str' });
  });
});

describe('pidfile', () => {
  it('uses ATPSYNC_STATE_DIR', async () => {
    const { root } = await tempEnv();
    expect(stateDir()).toBe(`${root}/state`);
    expect(pidPath()).toBe(`${root}/state/daemon.pid`);
  });

  it('writes, reads and removes a live pid', async () => {
    await tempEnv();
    expect(await readLivePid()).toBeNull();
    await writePidExclusive(process.pid);
    expect(await readLivePid()).toBe(process.pid);
    await removePid(process.pid);
    expect(await readLivePid()).toBeNull();
  });

  it('treats a dead pid as stale and removes the file', async () => {
    await tempEnv();
    const dead = deadPid();
    expect(isAlive(dead)).toBe(false);
    await fs.mkdir(stateDir(), { recursive: true });
    await fs.writeFile(pidPath(), String(dead));
    expect(await readLivePid()).toBeNull();
    await expect(fs.access(pidPath())).rejects.toThrow();
  });

  it('refuses to overwrite a live pid', async () => {
    await tempEnv();
    await writePidExclusive(process.ppid);
    await expect(writePidExclusive(process.pid)).rejects.toMatchObject({ code: 'ALREADY_RUNNING' });
  });

  it('removePid leaves another process’s pidfile alone', async () => {
    await tempEnv();
    await writePidExclusive(process.ppid);
    await removePid(process.pid);
    expect(await readLivePid()).toBe(process.ppid);
  });
});

describe('daemon state', () => {
  it('writes daemon.json and merges updates', async () => {
    const { vaultDir } = await tempEnv();
    expect(await readDaemonState(vaultDir)).toBeNull();
    const initial: DaemonState = {
      pid: 1, host: 'h', startedAt: 't', connection: 'poll',
      lastSyncAt: null, lastResult: null, lastError: null, lastExit: null,
    };
    const w = new DaemonStateWriter(vaultDir, initial);
    await Promise.all([w.update({ lastResult: 'ok' }), w.update({ connection: 'subscribed' })]);
    expect(await readDaemonState(vaultDir)).toEqual({ ...initial, lastResult: 'ok', connection: 'subscribed' });
    expect(w.current.connection).toBe('subscribed');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @atproto-sync/cli exec vitest run test/errors-state.test.ts`
Expected: FAIL — cannot resolve `../src/errors`.

- [ ] **Step 3: Implement**

Create `packages/cli/test/helpers.ts` with the content from the File Structure section above.

In `packages/cli/src/config.ts`:
- Add to `AtpsyncConfig`, after `syncIntervalMinutes`:
```ts
  /** Remote change detection: real-time subscribeRepos stream, or polling only. */
  remote: 'subscribe' | 'poll';
```
- In `DEFAULT_CONFIG` set `syncIntervalMinutes: 1,` and add `remote: 'subscribe',`. (`loadConfig` spreads defaults under the saved file, so old configs get `remote` and keep their saved interval; Task 5 pins this with a test.)
- Replace the module doc comment's "for the pi extension / CLI" with "for the atpsync CLI".

`packages/cli/src/errors.ts`:
```ts
/** Typed errors so the CLI and MCP layers can map failures to exit codes / error codes. */
export type ErrorCode = 'ERROR' | 'USAGE' | 'NOT_CONFIGURED' | 'LOCK_TIMEOUT' | 'AUTH' | 'ALREADY_RUNNING';

export const EXIT_CODES: Record<ErrorCode, number> = {
  ERROR: 1,
  USAGE: 2,
  NOT_CONFIGURED: 3,
  LOCK_TIMEOUT: 4,
  AUTH: 5,
  ALREADY_RUNNING: 1,
};

export class AtpsyncError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AtpsyncError';
  }
}

export function toAtpsyncError(err: unknown): AtpsyncError {
  if (err instanceof AtpsyncError) return err;
  return new AtpsyncError('ERROR', err instanceof Error ? err.message : String(err));
}
```

`packages/cli/src/paths.ts`:
```ts
/**
 * Per-machine daemon files live in the XDG state dir (not the vault, which may
 * be shared storage); per-vault coordination files live in <vault>/.atpsync/.
 */
import * as os from 'node:os';
import * as path from 'node:path';

export function stateDir(): string {
  return (
    process.env.ATPSYNC_STATE_DIR ||
    path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'atpsync')
  );
}

export const pidPath = (): string => path.join(stateDir(), 'daemon.pid');
export const logPath = (): string => path.join(stateDir(), 'daemon.log');
export const lockPath = (vaultDir: string): string => path.join(vaultDir, '.atpsync', 'lock');
export const daemonStatePath = (vaultDir: string): string => path.join(vaultDir, '.atpsync', 'daemon.json');
```

`packages/cli/src/pidfile.ts`:
```ts
/** The daemon pidfile: one daemon per machine, stale entries cleaned up on read. */
import { promises as fs } from 'node:fs';
import { AtpsyncError } from './errors';
import { pidPath, stateDir } from './paths';

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readPid(): Promise<number | null> {
  try {
    const n = Number.parseInt((await fs.readFile(pidPath(), 'utf8')).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** The running daemon's pid, or null. A pidfile naming a dead process is removed. */
export async function readLivePid(): Promise<number | null> {
  const pid = await readPid();
  if (pid === null) return null;
  if (isAlive(pid)) return pid;
  await fs.rm(pidPath(), { force: true });
  return null;
}

/** Claim the pidfile for `pid`; throws ALREADY_RUNNING if a live daemon holds it. */
export async function writePidExclusive(pid: number): Promise<void> {
  await fs.mkdir(stateDir(), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(pidPath(), String(pid), { flag: 'wx' });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const live = await readLivePid(); // removes a stale file
      if (live !== null) {
        throw new AtpsyncError('ALREADY_RUNNING', `atpsync daemon is already running (pid ${live}).`);
      }
    }
  }
  throw new AtpsyncError('ERROR', `Could not write ${pidPath()}.`);
}

/** Remove the pidfile; with `expected`, only if it still names that pid. */
export async function removePid(expected?: number): Promise<void> {
  if (expected !== undefined && (await readPid()) !== expected) return;
  await fs.rm(pidPath(), { force: true });
}
```

`packages/cli/src/daemon-state.ts`:
```ts
/**
 * <vault>/.atpsync/daemon.json: what the daemon last did, so `status` can
 * report it without IPC. Written atomically (tmp + rename), updates serialized.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { daemonStatePath } from './paths';

export type ConnectionMode = 'subscribed' | 'reconnecting' | 'poll';

export interface DaemonState {
  pid: number;
  host: string;
  startedAt: string;
  connection: ConnectionMode;
  lastSyncAt: string | null;
  lastResult: 'ok' | 'error' | null;
  lastError: string | null;
  lastExit: string | null;
}

export async function readDaemonState(vaultDir: string): Promise<DaemonState | null> {
  try {
    return JSON.parse(await fs.readFile(daemonStatePath(vaultDir), 'utf8')) as DaemonState;
  } catch {
    return null;
  }
}

export class DaemonStateWriter {
  private state: DaemonState;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly vaultDir: string,
    initial: DaemonState
  ) {
    this.state = { ...initial };
  }

  get current(): DaemonState {
    return { ...this.state };
  }

  update(patch: Partial<DaemonState>): Promise<void> {
    this.state = { ...this.state, ...patch };
    const snapshot = JSON.stringify(this.state, null, 2);
    this.chain = this.chain.then(() => this.write(snapshot)).catch(() => {});
    return this.chain;
  }

  private async write(json: string): Promise<void> {
    const file = daemonStatePath(this.vaultDir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, json, 'utf8');
    await fs.rename(`${file}.tmp`, file);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @atproto-sync/cli exec vitest run test/errors-state.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/errors.ts packages/cli/src/paths.ts packages/cli/src/pidfile.ts packages/cli/src/daemon-state.ts packages/cli/test/helpers.ts packages/cli/test/errors-state.test.ts
git commit -m "feat(cli): error codes, state paths, pidfile and daemon.json"
```

---

### Task 2: Vault lock

**Files:**
- Create: `packages/cli/src/lock.ts`
- Test: `packages/cli/test/lock.test.ts`

**Interfaces:**
- Consumes: `lockPath`, `isAlive`, `AtpsyncError` (Task 1).
- Produces:
  - `interface VaultLock { release(): Promise<void> }`
  - `interface LockOptions { timeoutMs?: number; pollMs?: number; heartbeatMs?: number; staleMs?: number }`
  - `tryAcquireLock(vaultDir: string, opts?: LockOptions): Promise<VaultLock | null>` — never waits.
  - `acquireLock(vaultDir: string, opts?: LockOptions): Promise<VaultLock>` — waits up to `timeoutMs` (default 60 000), then throws `AtpsyncError('LOCK_TIMEOUT')`.

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/lock.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { acquireLock, tryAcquireLock } from '../src/lock';
import { lockPath } from '../src/paths';
import { clearAtpsyncEnv, sleep, tempEnv } from './helpers';

afterEach(clearAtpsyncEnv);

async function writeLock(vaultDir: string, holder: object, ageMs = 0) {
  const file = lockPath(vaultDir);
  await fs.mkdir(`${vaultDir}/.atpsync`, { recursive: true });
  await fs.writeFile(file, JSON.stringify(holder));
  const t = new Date(Date.now() - ageMs);
  await fs.utimes(file, t, t);
}

describe('vault lock', () => {
  it('is exclusive until released', async () => {
    const { vaultDir } = await tempEnv();
    const a = await tryAcquireLock(vaultDir);
    expect(a).not.toBeNull();
    expect(await tryAcquireLock(vaultDir)).toBeNull();
    await a!.release();
    const b = await tryAcquireLock(vaultDir);
    expect(b).not.toBeNull();
    await b!.release();
    await expect(fs.access(lockPath(vaultDir))).rejects.toThrow();
  });

  it('breaks a lock held by a dead pid on this host', async () => {
    const { vaultDir } = await tempEnv();
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    await writeLock(vaultDir, { pid: dead, host: os.hostname(), startedAt: 'x' });
    const l = await tryAcquireLock(vaultDir);
    expect(l).not.toBeNull();
    await l!.release();
  });

  it('breaks a lock whose heartbeat is older than staleMs, even from another host', async () => {
    const { vaultDir } = await tempEnv();
    await writeLock(vaultDir, { pid: 1, host: 'other-host', startedAt: 'x' }, 3 * 60_000);
    const l = await tryAcquireLock(vaultDir);
    expect(l).not.toBeNull();
    await l!.release();
  });

  it('respects a fresh lock from another host', async () => {
    const { vaultDir } = await tempEnv();
    await writeLock(vaultDir, { pid: 1, host: 'other-host', startedAt: 'x' });
    expect(await tryAcquireLock(vaultDir)).toBeNull();
  });

  it('heartbeat keeps the lock fresh', async () => {
    const { vaultDir } = await tempEnv();
    const l = await tryAcquireLock(vaultDir, { heartbeatMs: 30 });
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(lockPath(vaultDir), old, old);
    await sleep(120);
    const { mtimeMs } = await fs.stat(lockPath(vaultDir));
    expect(Date.now() - mtimeMs).toBeLessThan(5_000);
    await l!.release();
  });

  it('acquireLock waits for release', async () => {
    const { vaultDir } = await tempEnv();
    const a = (await tryAcquireLock(vaultDir))!;
    setTimeout(() => void a.release(), 100);
    const b = await acquireLock(vaultDir, { timeoutMs: 2_000, pollMs: 20 });
    await b.release();
  });

  it('acquireLock times out with LOCK_TIMEOUT', async () => {
    const { vaultDir } = await tempEnv();
    const a = (await tryAcquireLock(vaultDir))!;
    await expect(acquireLock(vaultDir, { timeoutMs: 150, pollMs: 20 })).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    await a.release();
  });

  it('release does not delete a lock that was broken and re-taken by someone else', async () => {
    const { vaultDir } = await tempEnv();
    const a = (await tryAcquireLock(vaultDir))!;
    await writeLock(vaultDir, { pid: 1, host: 'other-host', startedAt: 'y' });
    await a.release();
    await expect(fs.access(lockPath(vaultDir))).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @atproto-sync/cli exec vitest run test/lock.test.ts`
Expected: FAIL — cannot resolve `../src/lock`.

- [ ] **Step 3: Implement**

`packages/cli/src/lock.ts`:
```ts
/**
 * Cross-process vault lock: <vault>/.atpsync/lock created with O_EXCL.
 * The holder refreshes the file's mtime every heartbeatMs; a lock is stale if
 * its holder is a dead pid on this host, or its mtime is older than staleMs
 * (a crashed holder on another machine sharing the folder).
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AtpsyncError } from './errors';
import { lockPath } from './paths';
import { isAlive } from './pidfile';

export interface VaultLock {
  release(): Promise<void>;
}

export interface LockOptions {
  /** acquireLock only: how long to wait (default 60 s). */
  timeoutMs?: number;
  /** acquireLock only: retry interval (default 250 ms). */
  pollMs?: number;
  heartbeatMs?: number;
  staleMs?: number;
}

interface Holder {
  pid: number;
  host: string;
  startedAt: string;
}

async function readHolder(file: string): Promise<Holder | null> {
  try {
    const h = JSON.parse(await fs.readFile(file, 'utf8')) as Holder;
    return typeof h.pid === 'number' && typeof h.host === 'string' ? h : null;
  } catch {
    return null;
  }
}

async function isStale(file: string, staleMs: number): Promise<boolean> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(file)).mtimeMs;
  } catch {
    return false; // vanished: the next create attempt decides
  }
  const age = Date.now() - mtimeMs;
  if (age > staleMs) return true;
  const holder = await readHolder(file);
  // Unreadable: possibly mid-write by its creator; only stale once it is a few seconds old.
  if (!holder) return age > 5_000;
  return holder.host === os.hostname() && !isAlive(holder.pid);
}

async function tryCreate(file: string, heartbeatMs: number): Promise<VaultLock | null> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const me: Holder = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() };
  try {
    await fs.writeFile(file, JSON.stringify(me), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    void fs.utimes(file, now, now).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref();
  return {
    async release() {
      clearInterval(heartbeat);
      const cur = await readHolder(file);
      if (cur && cur.pid === me.pid && cur.host === me.host && cur.startedAt === me.startedAt) {
        await fs.rm(file, { force: true });
      }
    },
  };
}

export async function tryAcquireLock(vaultDir: string, opts: LockOptions = {}): Promise<VaultLock | null> {
  const file = lockPath(vaultDir);
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const lock = await tryCreate(file, heartbeatMs);
  if (lock) return lock;
  if (await isStale(file, opts.staleMs ?? 2 * 60_000)) {
    await fs.rm(file, { force: true });
    return tryCreate(file, heartbeatMs);
  }
  return null;
}

export async function acquireLock(vaultDir: string, opts: LockOptions = {}): Promise<VaultLock> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    const lock = await tryAcquireLock(vaultDir, opts);
    if (lock) return lock;
    if (Date.now() >= deadline) {
      throw new AtpsyncError(
        'LOCK_TIMEOUT',
        'Timed out waiting for another atpsync process to finish syncing this vault.'
      );
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 250));
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @atproto-sync/cli exec vitest run test/lock.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lock.ts packages/cli/test/lock.test.ts
git commit -m "feat(cli): O_EXCL vault lock with heartbeat and stale detection"
```

---

### Task 3: Sync scheduler and fs watcher

**Files:**
- Create: `packages/cli/src/scheduler.ts`, `packages/cli/src/fs-watch.ts`
- Delete: `packages/cli/src/watcher.ts`
- Modify: `packages/cli/test/fixes.test.ts` (remove the `VaultWatcher` import and its `describe('VaultWatcher', …)` block — its two behaviors are re-pinned below)
- Test: `packages/cli/test/scheduler.test.ts`

**Interfaces:**
- Produces:
  - `type Trigger = 'startup' | 'fs' | 'remote' | 'poll'`; `type RunResult = 'ok' | 'busy'`
  - `DEFAULT_DEBOUNCE: Record<Trigger, number>` = `{ startup: 0, fs: 2000, remote: 500, poll: 0 }`
  - `interface SchedulerOptions { debounceMs?: Partial<Record<Trigger, number>>; busyRetryMs?: number; onError?: (err: unknown) => void }`
  - `class SyncScheduler { constructor(run: (reason: Trigger) => Promise<RunResult>, opts?: SchedulerOptions); trigger(reason: Trigger): void; setPollInterval(ms: number): void; stop(): Promise<void>; readonly isSyncing: boolean }`
  - `watchVault(root: string, ignore: (rel: string) => boolean, onChange: () => void, warn?: (m: string) => void): () => void` (returns unwatch)

Semantics the tests pin:
- A trigger re-arms the timer to `now + debounce[reason]` (so a burst of `fs` events extends the wait), **except** that a slower trigger never postpones an already-armed faster one.
- One run at a time. A trigger during a run is remembered as `pending` and, after the run, scheduled through its own debounce.
- `run` returning `'busy'` (vault locked elsewhere) re-arms after `busyRetryMs` (default 2000).
- A throwing `run` goes to `onError`; the scheduler keeps working.
- `stop()` clears timers and resolves after any in-flight run.

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/scheduler.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SyncScheduler, type RunResult, type Trigger } from '../src/scheduler';
import { watchVault } from '../src/fs-watch';
import { isIgnored } from '@atproto-sync/core/sync/ignore';

describe('SyncScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function recorder(result: RunResult = 'ok') {
    const runs: Trigger[] = [];
    const run = vi.fn(async (r: Trigger) => {
      runs.push(r);
      return result;
    });
    return { runs, run };
  }

  it('coalesces a burst of 50 fs events into one run after 2 s of quiet', async () => {
    const { runs, run } = recorder();
    const s = new SyncScheduler(run);
    for (let i = 0; i < 50; i++) {
      s.trigger('fs');
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(1999);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(['fs']);
    await s.stop();
  });

  it('runs startup immediately and remote after 500 ms', async () => {
    const { runs, run } = recorder();
    const s = new SyncScheduler(run);
    s.trigger('startup');
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual(['startup']);
    s.trigger('remote');
    await vi.advanceTimersByTimeAsync(499);
    expect(runs).toEqual(['startup']);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(['startup', 'remote']);
    await s.stop();
  });

  it('a slower trigger does not postpone an armed faster one', async () => {
    const { runs, run } = recorder();
    const s = new SyncScheduler(run);
    s.trigger('remote');
    s.trigger('fs');
    await vi.advanceTimersByTimeAsync(500);
    expect(runs).toEqual(['remote']);
    await s.stop();
  });

  it('never runs concurrently; a trigger mid-run is rescheduled through its debounce', async () => {
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const runs: Trigger[] = [];
    const s = new SyncScheduler(async (r) => {
      runs.push(r);
      active++;
      maxActive = Math.max(maxActive, active);
      if (runs.length === 1) await new Promise<void>((res) => (release = res));
      active--;
      return 'ok';
    });
    s.trigger('startup');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.isSyncing).toBe(true);
    s.trigger('fs');
    s.trigger('fs');
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toEqual(['startup']);
    release();
    await vi.advanceTimersByTimeAsync(1999);
    expect(runs).toEqual(['startup']);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(['startup', 'fs']);
    expect(maxActive).toBe(1);
    await s.stop();
  });

  it('retries after busyRetryMs when the vault is locked elsewhere', async () => {
    const results: RunResult[] = ['busy', 'ok'];
    const run = vi.fn(async () => results.shift()!);
    const s = new SyncScheduler(run, { busyRetryMs: 300 });
    s.trigger('startup');
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(2);
    await s.stop();
  });

  it('reports a throwing run to onError and keeps scheduling', async () => {
    const onError = vi.fn();
    let n = 0;
    const s = new SyncScheduler(async () => {
      if (n++ === 0) throw new Error('boom');
      return 'ok';
    }, { onError });
    s.trigger('startup');
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    s.trigger('startup');
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(2);
    await s.stop();
  });

  it('fires poll on the configured interval and can be re-timed', async () => {
    const { runs, run } = recorder();
    const s = new SyncScheduler(run);
    s.setPollInterval(1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(runs).toEqual(['poll', 'poll', 'poll']);
    s.setPollInterval(10_000);
    await vi.advanceTimersByTimeAsync(9000);
    expect(runs.length).toBe(3);
    await s.stop();
  });

  it('stop() waits for the in-flight run and cancels pending work', async () => {
    let release!: () => void;
    let finished = false;
    const s = new SyncScheduler(async () => {
      await new Promise<void>((res) => (release = res));
      finished = true;
      return 'ok';
    });
    s.trigger('startup');
    await vi.advanceTimersByTimeAsync(0);
    s.trigger('fs');
    const stopped = s.stop();
    release();
    await stopped;
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
  });
});

describe('watchVault', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("ignores the engine's own .atpsync writes but reports note edits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atpsync-watch-'));
    let changes = 0;
    const unwatch = watchVault(root, (rel) => isIgnored(rel, ['.atpsync/']), () => changes++);
    await fs.mkdir(path.join(root, '.atpsync'));
    await fs.writeFile(path.join(root, '.atpsync', 'index.json'), '[]');
    await sleep(300);
    expect(changes).toBe(0);
    await fs.writeFile(path.join(root, 'note.md'), 'hi');
    await sleep(300);
    expect(changes).toBeGreaterThan(0);
    unwatch();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @atproto-sync/cli exec vitest run test/scheduler.test.ts`
Expected: FAIL — cannot resolve `../src/scheduler`.

- [ ] **Step 3: Implement**

`packages/cli/src/scheduler.ts`:
```ts
/**
 * One sync at a time, fed by several trigger sources with their own debounce.
 * A burst of the same trigger extends the wait (debounce); a slower trigger
 * never postpones a faster one already armed. Triggers that land mid-sync are
 * remembered and rescheduled through their debounce afterwards, so the
 * engine's own writes settle before the follow-up run.
 */
export type Trigger = 'startup' | 'fs' | 'remote' | 'poll';
export type RunResult = 'ok' | 'busy';

export const DEFAULT_DEBOUNCE: Record<Trigger, number> = { startup: 0, fs: 2000, remote: 500, poll: 0 };

export interface SchedulerOptions {
  debounceMs?: Partial<Record<Trigger, number>>;
  /** Delay before retrying when run() reports the vault is locked elsewhere (default 2000). */
  busyRetryMs?: number;
  onError?: (err: unknown) => void;
}

export class SyncScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private armedDelay = Infinity;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private pending: Trigger | null = null;
  private stopped = false;
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    private readonly run: (reason: Trigger) => Promise<RunResult>,
    private readonly opts: SchedulerOptions = {}
  ) {}

  get isSyncing(): boolean {
    return this.syncing;
  }

  trigger(reason: Trigger): void {
    if (this.stopped) return;
    if (this.syncing) {
      this.pending = reason;
      return;
    }
    this.arm(this.delayFor(reason), reason);
  }

  setPollInterval(ms: number): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = this.stopped ? null : setInterval(() => this.trigger('poll'), ms);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.timer = null;
    this.pollTimer = null;
    this.pending = null;
    await this.inflight;
  }

  private delayFor(reason: Trigger): number {
    return this.opts.debounceMs?.[reason] ?? DEFAULT_DEBOUNCE[reason];
  }

  private arm(delay: number, reason: Trigger): void {
    if (this.timer && this.armedDelay < delay) return; // a faster run is already queued
    if (this.timer) clearTimeout(this.timer);
    this.armedDelay = delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.armedDelay = Infinity;
      this.inflight = this.execute(reason);
    }, delay);
  }

  private async execute(reason: Trigger): Promise<void> {
    if (this.stopped) return;
    this.syncing = true;
    let result: RunResult = 'ok';
    try {
      result = await this.run(reason);
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.syncing = false;
    }
    if (this.stopped) return;
    if (result === 'busy') {
      this.pending = null;
      this.arm(this.opts.busyRetryMs ?? 2000, reason);
      return;
    }
    if (this.pending) {
      const next = this.pending;
      this.pending = null;
      this.arm(this.delayFor(next), next);
    }
  }
}
```

`packages/cli/src/fs-watch.ts`:
```ts
/**
 * Recursive fs.watch over the vault. Events on ignored paths are dropped so the
 * engine's own <vault>/.atpsync/ writes don't re-trigger a sync. Where
 * recursive watching is unsupported the caller still has the poll interval.
 */
import { watch } from 'node:fs';

export function watchVault(
  root: string,
  ignore: (rel: string) => boolean,
  onChange: () => void,
  warn: (m: string) => void = () => {}
): () => void {
  try {
    const w = watch(root, { recursive: true }, (_event, filename) => {
      if (filename != null && ignore(String(filename).split('\\').join('/'))) return;
      onChange();
    });
    w.on('error', (err) => warn(`file watcher error: ${err.message}`));
    return () => w.close();
  } catch (err) {
    warn(`fs.watch failed (${(err as Error).message}); polling only.`);
    return () => {};
  }
}
```

Delete the old watcher and its tests:
```bash
git rm -q packages/cli/src/watcher.ts
```
In `packages/cli/test/fixes.test.ts` remove the line `import { VaultWatcher } from '../src/watcher';` and the entire `describe('VaultWatcher', () => { … });` block (both `it`s). Leave the `isIgnored` import if other tests still use it; otherwise remove it too.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @atproto-sync/cli exec vitest run test/scheduler.test.ts test/fixes.test.ts && pnpm --filter @atproto-sync/cli typecheck`
Expected: PASS (9 scheduler/watch tests; fixes suite passes minus the two removed); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A packages/cli
git commit -m "feat(cli): SyncScheduler with per-trigger debounce; replace VaultWatcher"
```

---

### Task 4: `subscribeRepos` listener

**Files:**
- Create: `packages/cli/src/subscription.ts`
- Modify: `packages/cli/package.json` (deps)
- Test: `packages/cli/test/subscription.test.ts`

**Interfaces:**
- Produces:
  - `interface Frame { header: { op: number; t?: string }; body: Record<string, unknown> }`
  - `decodeFrame(bytes: Uint8Array): Frame | null` — never throws.
  - `isRelevantCommit(frame: Frame, did: string): boolean`
  - `subscribeReposUrl(pdsUrl: string): string`
  - `backoffDelay(attempt: number, minMs: number, maxMs: number, random?: () => number): number`
  - `type SubscriptionState = 'subscribed' | 'reconnecting'`
  - `interface SubscriptionTarget { pdsUrl: string; did: string }`
  - `interface SubscriptionOptions { resolveTarget(): Promise<SubscriptionTarget>; onRelevant(): void; onState(s: SubscriptionState): void; log?(m: string): void; minBackoffMs?: number; maxBackoffMs?: number }`
  - `class RepoSubscription { constructor(opts: SubscriptionOptions); start(): void; stop(): void }`

Background for the implementer: a `subscribeRepos` websocket message is one binary frame holding two concatenated DAG-CBOR values: a header `{op, t}` (`op: 1` = message with type `t` such as `"#commit"`, `op: -1` = error with body `{error, message}`), then the body. A `#commit` body has `repo` (DID) and `ops: [{action, path: "<collection>/<rkey>", cid}]`. CIDs are CBOR tag 42; we accept the tag but never interpret it.

- [ ] **Step 1: Add dependencies**

Run: `pnpm --filter @atproto-sync/cli add cborg@^6.1.3 && pnpm --filter @atproto-sync/cli add -D ws@^8.22.0 @types/ws@^8.18.2`

- [ ] **Step 2: Write the failing tests**

`packages/cli/test/subscription.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { encode } from 'cborg';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import {
  RepoSubscription,
  backoffDelay,
  decodeFrame,
  isRelevantCommit,
  subscribeReposUrl,
  type SubscriptionState,
} from '../src/subscription';
import { waitFor } from './helpers';

const ME = 'did:plc:me';

function frame(header: object, body: object): Uint8Array {
  const h = encode(header);
  const b = encode(body);
  const out = new Uint8Array(h.length + b.length);
  out.set(h, 0);
  out.set(b, h.length);
  return out;
}
const commit = (repo: string, paths: string[]) =>
  frame({ op: 1, t: '#commit' }, { repo, ops: paths.map((p) => ({ action: 'create', path: p, cid: null })) });

describe('frame decoding', () => {
  it('decodes header and body', () => {
    const f = decodeFrame(commit(ME, ['app.notesky.note/abc']));
    expect(f?.header).toEqual({ op: 1, t: '#commit' });
    expect(f?.body.repo).toBe(ME);
  });

  it('accepts CID tags (tag 42) without interpreting them', () => {
    const header = encode({ op: 1, t: '#commit' });
    // body = { "c": tag42(h'00') }
    const body = Uint8Array.of(0xa1, 0x61, 0x63, 0xd8, 0x2a, 0x41, 0x00);
    const bytes = new Uint8Array(header.length + body.length);
    bytes.set(header, 0);
    bytes.set(body, header.length);
    expect(decodeFrame(bytes)).not.toBeNull();
  });

  it('returns null for garbage and truncated frames', () => {
    expect(decodeFrame(Uint8Array.of(0xff, 0x00, 0x13))).toBeNull();
    const ok = commit(ME, ['app.notesky.note/abc']);
    expect(decodeFrame(ok.slice(0, ok.length - 3))).toBeNull();
    expect(decodeFrame(new Uint8Array())).toBeNull();
  });

  it('only notesky commits for our DID are relevant', () => {
    expect(isRelevantCommit(decodeFrame(commit(ME, ['app.notesky.note/a']))!, ME)).toBe(true);
    expect(isRelevantCommit(decodeFrame(commit(ME, ['app.bsky.feed.post/a', 'app.notesky.vault/v']))!, ME)).toBe(true);
    expect(isRelevantCommit(decodeFrame(commit('did:plc:other', ['app.notesky.note/a']))!, ME)).toBe(false);
    expect(isRelevantCommit(decodeFrame(commit(ME, ['app.bsky.feed.post/a']))!, ME)).toBe(false);
    expect(isRelevantCommit(decodeFrame(frame({ op: 1, t: '#identity' }, { did: ME }))!, ME)).toBe(false);
  });
});

describe('helpers', () => {
  it('builds ws/wss URLs', () => {
    expect(subscribeReposUrl('https://pds.example.com')).toBe('wss://pds.example.com/xrpc/com.atproto.sync.subscribeRepos');
    expect(subscribeReposUrl('http://localhost:2583/')).toBe('ws://localhost:2583/xrpc/com.atproto.sync.subscribeRepos');
  });

  it('backs off exponentially with jitter, capped', () => {
    expect(backoffDelay(0, 1000, 60_000, () => 0)).toBe(500);
    expect(backoffDelay(0, 1000, 60_000, () => 1)).toBe(1000);
    expect(backoffDelay(3, 1000, 60_000, () => 1)).toBe(8000);
    expect(backoffDelay(20, 1000, 60_000, () => 1)).toBe(60_000);
    expect(backoffDelay(20, 1000, 60_000, () => 0)).toBe(30_000);
  });
});

describe('RepoSubscription against a local websocket server', () => {
  let wss: WebSocketServer | null = null;
  let sub: RepoSubscription | null = null;
  afterEach(async () => {
    sub?.stop();
    await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
    wss = null;
  });

  async function server(onConn: (s: WsSocket, url: string) => void): Promise<string> {
    wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (s, req) => onConn(s, req.url ?? ''));
    await new Promise<void>((r) => wss!.once('listening', () => r()));
    return `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  }

  it('fires onRelevant for matching commits, ignores others, reconnects after close and after an error frame', async () => {
    const urls: string[] = [];
    let connections = 0;
    const pdsUrl = await server((s, url) => {
      urls.push(url);
      connections++;
      if (connections === 1) {
        s.send(commit('did:plc:other', ['app.notesky.note/x']));
        s.send(Uint8Array.of(0xff, 0x00)); // garbage: must be skipped
        s.send(commit(ME, ['app.notesky.note/a']));
        setTimeout(() => s.close(), 50);
      } else if (connections === 2) {
        s.send(frame({ op: -1 }, { error: 'FutureCursor', message: 'nope' }));
      } else {
        s.send(commit(ME, ['app.notesky.attachment/b']));
      }
    });
    const states: SubscriptionState[] = [];
    let relevant = 0;
    sub = new RepoSubscription({
      resolveTarget: async () => ({ pdsUrl, did: ME }),
      onRelevant: () => relevant++,
      onState: (s) => states.push(s),
      minBackoffMs: 20,
      maxBackoffMs: 40,
    });
    sub.start();
    await waitFor(() => relevant === 2 && connections >= 3);
    expect(urls[0]).toBe('/xrpc/com.atproto.sync.subscribeRepos');
    expect(states.filter((s) => s === 'subscribed').length).toBeGreaterThanOrEqual(3);
    expect(states).toContain('reconnecting');
  });

  it('retries when resolving the target fails', async () => {
    const pdsUrl = await server(() => {});
    let calls = 0;
    const states: SubscriptionState[] = [];
    sub = new RepoSubscription({
      resolveTarget: async () => {
        if (calls++ === 0) throw new Error('offline');
        return { pdsUrl, did: ME };
      },
      onRelevant: () => {},
      onState: (s) => states.push(s),
      minBackoffMs: 20,
      maxBackoffMs: 40,
    });
    sub.start();
    await waitFor(() => states.includes('subscribed'));
    expect(states[0]).toBe('reconnecting');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @atproto-sync/cli exec vitest run test/subscription.test.ts`
Expected: FAIL — cannot resolve `../src/subscription`.

- [ ] **Step 4: Implement**

`packages/cli/src/subscription.ts`:
```ts
/**
 * Real-time remote-change hints from our own PDS's com.atproto.sync.subscribeRepos.
 * We only inspect frame headers and commit op paths: an event means "sync now",
 * and the engine re-reads records over XRPC, so nothing here is trusted and
 * signatures are not verified. No cursor is persisted; the caller does a full
 * sync on every (re)connect to cover gaps.
 */
import { decodeFirst } from 'cborg';

export interface Frame {
  header: { op: number; t?: string };
  body: Record<string, unknown>;
}

// CIDs are CBOR tag 42; accept them as opaque values.
const TAGS: ((inner: { decode(): unknown }) => unknown)[] = [];
TAGS[42] = (ctl) => ctl.decode();

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function decodeFrame(bytes: Uint8Array): Frame | null {
  try {
    const [header, rest] = decodeFirst(bytes, { tags: TAGS as never });
    const [body] = decodeFirst(rest, { tags: TAGS as never });
    if (!isObject(header) || typeof header.op !== 'number' || !isObject(body)) return null;
    return { header: header as Frame['header'], body };
  } catch {
    return null;
  }
}

export function isRelevantCommit(frame: Frame, did: string): boolean {
  if (frame.header.op !== 1 || frame.header.t !== '#commit') return false;
  if (frame.body.repo !== did || !Array.isArray(frame.body.ops)) return false;
  return frame.body.ops.some(
    (op) => isObject(op) && typeof op.path === 'string' && op.path.startsWith('app.notesky.')
  );
}

export function subscribeReposUrl(pdsUrl: string): string {
  const u = new URL('/xrpc/com.atproto.sync.subscribeRepos', pdsUrl);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  return u.toString();
}

/** Exponential backoff with jitter: a value in [base/2, base], base = min(max, min·2^attempt). */
export function backoffDelay(attempt: number, minMs: number, maxMs: number, random: () => number = Math.random): number {
  const base = Math.min(maxMs, minMs * 2 ** attempt);
  return Math.round(base / 2 + (random() * base) / 2);
}

export type SubscriptionState = 'subscribed' | 'reconnecting';

export interface SubscriptionTarget {
  pdsUrl: string;
  did: string;
}

export interface SubscriptionOptions {
  resolveTarget(): Promise<SubscriptionTarget>;
  onRelevant(): void;
  onState(state: SubscriptionState): void;
  log?(message: string): void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export class RepoSubscription {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: SubscriptionOptions) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let target: SubscriptionTarget;
    try {
      target = await this.opts.resolveTarget();
    } catch (err) {
      this.opts.log?.(`event stream: cannot reach PDS (${(err as Error).message})`);
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    const ws = new WebSocket(subscribeReposUrl(target.pdsUrl));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.opts.onState('subscribed');
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const f = decodeFrame(new Uint8Array(ev.data));
      if (!f) return;
      if (f.header.op === -1) {
        this.opts.log?.(`event stream error: ${String(f.body.error)} ${String(f.body.message ?? '')}`.trim());
        ws.close();
        return;
      }
      if (isRelevantCommit(f, target.did)) this.opts.onRelevant();
    };
    ws.onerror = () => {}; // a close event always follows
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.opts.onState('reconnecting');
    const delay = backoffDelay(this.attempt++, this.opts.minBackoffMs ?? 1000, this.opts.maxBackoffMs ?? 60_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @atproto-sync/cli exec vitest run test/subscription.test.ts && pnpm --filter @atproto-sync/cli typecheck`
Expected: PASS (8 tests); typecheck clean. If `decodeFirst`'s `tags` option type rejects the array, keep the `as never` casts — the runtime contract (tag decoder receives a control object and must call `decode()`) is what cborg 6 requires.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/package.json pnpm-lock.yaml packages/cli/src/subscription.ts packages/cli/test/subscription.test.ts
git commit -m "feat(cli): subscribeRepos listener with commit filtering and backoff reconnect"
```

---

### Task 5: Config, connection and session changes

**Files:**
- Modify: `packages/core/src/atproto/pds-client.ts:31` (`private readonly did` → `readonly did`)
- Modify: `packages/cli/src/config.ts`, `packages/cli/src/session.ts`, `packages/cli/src/setup.ts`
- Modify: `packages/cli/test/fixes.test.ts` (new call signatures)
- Test: `packages/cli/test/session.test.ts`

**Interfaces:**
- Consumes: `AtpsyncError` (Task 1).
- Produces:
  - (`AtpsyncConfig.remote` and the 1-minute default already exist from Task 1; this task pins them with a test.)
  - `interface Connection { pds: PdsClient; did: string; pdsUrl: string }`; `type Connect = (cfg: AtpsyncConfig) => Promise<Connection>`
  - `connect(cfg, deps?: { login?: typeof login; resolvePdsUrl?: typeof resolvePdsUrl }): Promise<Connection>` — cached per identifier+override; login rejection with HTTP 401 → `AtpsyncError('AUTH')`.
  - `clearConnectionCache(): void` (replaces `clearPdsCache`); `isAuthFailure(err: unknown): boolean`
  - `runSync(cfg, hooks?: SyncHooks): Promise<SyncSummary>` (the unused `cwd` parameter is removed)
  - `togglePublic(cfg, relPath, makePublic, slug?, hooks?): Promise<ToggleResult>` where `interface ToggleResult { changed: boolean; message: string; summary: SyncSummary | null }`
  - `getVaultStatus(cfg, connectFn?: Connect): Promise<VaultStatus>` where `VaultStatus = { identifier; vaultRkey; vaultDir; vaultName: string | null; pdsUrl: string | null; localNotes: number; remote: { notes: number; attachments: number } | null; remoteError: string | null; lastSyncAt: string | null }`
  - Not-configured / unbound-vault errors are `AtpsyncError('NOT_CONFIGURED')`.

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/session.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { FakePds } from '@atproto-sync/core/sync/fake-pds';
import { DEFAULT_CONFIG, loadConfig, saveConfig, configPath } from '../src/config';
import { clearConnectionCache, connect, getVaultStatus, runSync } from '../src/session';
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @atproto-sync/cli exec vitest run test/session.test.ts`
Expected: FAIL — `connect`/`clearConnectionCache` not exported (the config-defaults test already passes).

- [ ] **Step 3: Config**

In `packages/cli/src/config.ts` (the `remote` field already exists from Task 1):
- In `boundVaultDir`, throw `new AtpsyncError('NOT_CONFIGURED', 'No vault directory is bound. Run `atpsync setup [folder]`, or set ATPSYNC_VAULT_DIR.')` (import `AtpsyncError` from `./errors`).

- [ ] **Step 4: Make the session DID readable in core**

`packages/core/src/atproto/pds-client.ts`, in the `RealPdsClient` constructor: change `private readonly did: string` to `readonly did: string`.

- [ ] **Step 5: Session**

In `packages/cli/src/session.ts`, replace `pdsCache`, `clearPdsCache` and `makePdsClient` with:
```ts
export interface Connection {
  pds: PdsClient;
  did: string;
  pdsUrl: string;
}
export type Connect = (cfg: AtpsyncConfig) => Promise<Connection>;

export interface ConnectDeps {
  login?: typeof login;
  resolvePdsUrl?: typeof resolvePdsUrl;
}

let connCache: { key: string; conn: Connection } | null = null;

/** Drop the cached session (after logout, setup, or an auth failure). */
export function clearConnectionCache(): void {
  connCache = null;
}

export function isAuthFailure(err: unknown): boolean {
  const e = err as { status?: unknown; error?: unknown } | null;
  return Number(e?.status) === 401 || e?.error === 'AuthenticationRequired' || e?.error === 'ExpiredToken';
}

/** App-password login (cached per identifier + PDS override). */
export async function connect(cfg: AtpsyncConfig, deps: ConnectDeps = {}): Promise<Connection> {
  const key = `${cfg.identifier}|${cfg.pdsUrlOverride || ''}`;
  if (connCache && connCache.key === key) return connCache.conn;
  const pdsUrl = cfg.pdsUrlOverride || (await (deps.resolvePdsUrl ?? resolvePdsUrl)(cfg.identifier)).pdsUrl;
  let client: RealPdsClient;
  try {
    client = await (deps.login ?? login)({ identifier: cfg.identifier, password: cfg.appPassword, pdsUrl });
  } catch (err) {
    if (isAuthFailure(err)) {
      throw new AtpsyncError(
        'AUTH',
        `Sign-in failed for ${cfg.identifier} (${(err as Error).message}). Check the app password or run \`atpsync setup\`.`
      );
    }
    throw err;
  }
  const conn: Connection = { pds: client, did: client.did, pdsUrl };
  connCache = { key, conn };
  return conn;
}
```
Add `import { AtpsyncError } from './errors';`.

Change `runSync`:
- signature `export async function runSync(cfg: AtpsyncConfig, hooks: SyncHooks = {}): Promise<SyncSummary>`
- not-configured: `throw new AtpsyncError('NOT_CONFIGURED', 'Not configured yet. Run `atpsync setup` first (handle, app password, passphrase).');`
- `const pds = hooks.pds ?? (await connect(cfg)).pds;`

Change `togglePublic`:
```ts
export interface ToggleResult {
  changed: boolean;
  message: string;
  summary: SyncSummary | null;
}

/** Flip a note's public flag in its frontmatter, then sync. */
export async function togglePublic(
  cfg: AtpsyncConfig,
  relPath: string,
  makePublic: boolean,
  slug?: string,
  hooks: SyncHooks = {}
): Promise<ToggleResult> {
  // …existing body up to the no-change check, unchanged…
  if (makePublic === publicNow) {
    return { changed: false, message: `No change: "${relPath}" is already ${publicNow ? 'public' : 'private'}.`, summary: null };
  }
  const next = makePublic ? setPublicFlag(content, slug) : removePublicFlag(content);
  await fs.writeFile(abs, next, 'utf8');
  const summary = await runSync(cfg, hooks);
  const message = makePublic
    ? `"${relPath}" is now public${slug ? ` at /${slug}` : ''} (plaintext record, embedded attachments cascade to public).`
    : `"${relPath}" is now private again (record re-encrypted, key rotated).`;
  return { changed: true, message, summary };
}
```

Replace `VaultStatus` and `getVaultStatus`:
```ts
export interface VaultStatus {
  identifier: string;
  vaultRkey: string;
  vaultDir: string;
  vaultName: string | null;
  pdsUrl: string | null;
  localNotes: number;
  /** null when the PDS could not be reached (see remoteError). */
  remote: { notes: number; attachments: number } | null;
  remoteError: string | null;
  lastSyncAt: string | null;
}

/** Snapshot of the account/vault state. Local counts always; remote counts when reachable. */
export async function getVaultStatus(cfg: AtpsyncConfig, connectFn: Connect = connect): Promise<VaultStatus> {
  const vaultDir = boundVaultDir(cfg);
  const localNotes = await new FsVaultAdapter(vaultDir, () => cfg.ignorePatterns).countMarkdown();
  const status: VaultStatus = {
    identifier: cfg.identifier,
    vaultRkey: cfg.vaultRkey,
    vaultDir,
    vaultName: null,
    pdsUrl: cfg.pdsUrlOverride || null,
    localNotes,
    remote: null,
    remoteError: null,
    lastSyncAt: cfg.lastSyncAt ?? null,
  };
  try {
    const { pds, pdsUrl } = await connectFn(cfg);
    const [notes, atts, vaultRec] = await Promise.all([
      pds.listRecords(NOTE_COLLECTION),
      pds.listRecords(ATTACHMENT_COLLECTION),
      pds.getRecord(VAULT_COLLECTION, cfg.vaultRkey),
    ]);
    const mine = (r: { value: unknown }) => (r.value as { vault?: string }).vault === cfg.vaultRkey;
    status.pdsUrl = pdsUrl;
    status.remote = { notes: notes.filter(mine).length, attachments: atts.filter(mine).length };
    if (vaultRec) status.vaultName = (vaultRec.value as VaultRecord).name ?? null;
  } catch (err) {
    status.remoteError = (err as Error).message;
  }
  return status;
}
```

Run: `grep -n "makePdsClient\|clearPdsCache\|/atpsync" packages/cli/src/*.ts`
Fix every hit: `setup.ts`'s final notify becomes ``Run `atpsync start` to sync in the background.``; every other `/atpsync X` string becomes `` `atpsync X` ``.

- [ ] **Step 6: Update the ported tests for the new signatures**

In `packages/cli/test/fixes.test.ts`:
- `runSync(cfg, '/some/cwd', { pds: new FakePds() })` → `runSync(cfg, { pds: new FakePds() })`; same for `runSync(cfg, '/elsewhere', …)`.
- `togglePublic(cfg, '/cwd', X, …)` → `togglePublic(cfg, X, …)` (three call sites).
- In "publishes a note and syncs it as plaintext": `const msg = await togglePublic(…)` → `const r = await togglePublic(cfg, 'post.md', true, 'hello', { pds });` and `expect(msg).toMatch(/now public/)` → `expect(r.changed).toBe(true); expect(r.message).toMatch(/now public/);`.
- Where the `configuredCfg` helper in that file builds a config from `DEFAULT_CONFIG`, nothing else changes (`remote` comes from the defaults).

- [ ] **Step 7: Run to verify pass**

Run: `pnpm --filter @atproto-sync/cli test && pnpm -r typecheck`
Expected: all cli tests pass (session 7 new); whole-workspace typecheck clean (the core `did` change is additive).

- [ ] **Step 8: Commit**

```bash
git add -A packages/cli packages/core/src/atproto/pds-client.ts
git commit -m "feat(cli): cached connect() with DID and PDS URL, offline-tolerant status, remote config"
```

---

### Task 6: Command layer and text rendering

**Files:**
- Create: `packages/cli/src/commands/context.ts`, `packages/cli/src/commands/status.ts`, `packages/cli/src/commands/sync.ts`, `packages/cli/src/commands/publish.ts`, `packages/cli/src/render.ts`
- Test: `packages/cli/test/commands.test.ts`

**Interfaces:**
- Consumes: `connect`, `Connect`, `runSync`, `togglePublic`, `getVaultStatus`, `SyncSummary`, `VaultStatus` (Task 5); `acquireLock`, `tryAcquireLock` (Task 2); `readLivePid` (Task 1); `readDaemonState`, `DaemonState` (Task 1).
- Produces:
  - `interface CommandDeps { loadConfig(): Promise<AtpsyncConfig>; connect: Connect; lock: { wait: boolean; timeoutMs: number } }`; `defaultDeps(): CommandDeps`
  - `requireConfig(deps): Promise<AtpsyncConfig>` (throws `NOT_CONFIGURED`)
  - `withVaultLock<T>(vaultDir: string, lock: CommandDeps['lock'], fn: () => Promise<T>): Promise<T>`
  - `statusCommand(deps): Promise<StatusResult>`; `interface StatusResult extends VaultStatus { ok: true; daemon: DaemonInfo }`; `interface DaemonInfo { running: boolean; pid: number | null; connection: DaemonState['connection'] | null; lastSyncAt: string | null; lastError: string | null; lastExit: string | null }`
  - `syncCommand(deps): Promise<SyncSummary>` (already has `ok: true`)
  - `publishCommand(deps, args: { path: string; makePublic: boolean; slug?: string }): Promise<PublishResult>`; `interface PublishResult { ok: true; path: string; published: boolean; changed: boolean; message: string; sync: SyncSummary | null }`
  - `renderStatus(r: StatusResult): string`, `renderSync(r: SyncSummary): string`, `renderPublish(r: PublishResult): string`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/commands.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { FakePds } from '@atproto-sync/core/sync/fake-pds';
import { DEFAULT_CONFIG, saveConfig, type AtpsyncConfig } from '../src/config';
import type { CommandDeps } from '../src/commands/context';
import { statusCommand } from '../src/commands/status';
import { syncCommand } from '../src/commands/sync';
import { publishCommand } from '../src/commands/publish';
import { renderStatus } from '../src/render';
import { tryAcquireLock } from '../src/lock';
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

  it('never exposes the app password or master key', async () => {
    const { cfg } = await setup();
    const r = await statusCommand(depsFor(cfg));
    const json = JSON.stringify(r) + renderStatus(r);
    expect(json).not.toContain(cfg.appPassword);
    expect(json).not.toContain(cfg.masterKeyB64);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @atproto-sync/cli exec vitest run test/commands.test.ts`
Expected: FAIL — cannot resolve `../src/commands/context`.

- [ ] **Step 3: Implement**

`packages/cli/src/commands/context.ts`:
```ts
/** Shared plumbing for command functions (used by both the CLI and the MCP server). */
import { configPath, isConfigured, loadConfig, type AtpsyncConfig } from '../config';
import { AtpsyncError } from '../errors';
import { acquireLock, tryAcquireLock } from '../lock';
import { connect, type Connect } from '../session';

export interface CommandDeps {
  loadConfig(): Promise<AtpsyncConfig>;
  connect: Connect;
  lock: { wait: boolean; timeoutMs: number };
}

export function defaultDeps(): CommandDeps {
  return { loadConfig, connect: (cfg) => connect(cfg), lock: { wait: true, timeoutMs: 60_000 } };
}

export async function requireConfig(deps: CommandDeps): Promise<AtpsyncConfig> {
  const cfg = await deps.loadConfig();
  if (!isConfigured(cfg)) {
    throw new AtpsyncError(
      'NOT_CONFIGURED',
      `atpsync is not configured on this machine (${configPath()}). Run \`atpsync setup\` first.`
    );
  }
  return cfg;
}

export async function withVaultLock<T>(
  vaultDir: string,
  lock: CommandDeps['lock'],
  fn: () => Promise<T>
): Promise<T> {
  const held = lock.wait ? await acquireLock(vaultDir, { timeoutMs: lock.timeoutMs }) : await tryAcquireLock(vaultDir);
  if (!held) {
    throw new AtpsyncError('LOCK_TIMEOUT', 'Another atpsync process is syncing this vault right now.');
  }
  try {
    return await fn();
  } finally {
    await held.release();
  }
}
```

`packages/cli/src/commands/sync.ts`:
```ts
import { boundVaultDir } from '../config';
import { runSync, type SyncSummary } from '../session';
import { requireConfig, withVaultLock, type CommandDeps } from './context';

export async function syncCommand(deps: CommandDeps): Promise<SyncSummary> {
  const cfg = await requireConfig(deps);
  return withVaultLock(boundVaultDir(cfg), deps.lock, async () => {
    const { pds } = await deps.connect(cfg);
    return runSync(cfg, { pds });
  });
}
```

`packages/cli/src/commands/publish.ts`:
```ts
import { boundVaultDir } from '../config';
import { togglePublic, type SyncSummary } from '../session';
import { requireConfig, withVaultLock, type CommandDeps } from './context';

export interface PublishResult {
  ok: true;
  path: string;
  published: boolean;
  changed: boolean;
  message: string;
  sync: SyncSummary | null;
}

export async function publishCommand(
  deps: CommandDeps,
  args: { path: string; makePublic: boolean; slug?: string }
): Promise<PublishResult> {
  const cfg = await requireConfig(deps);
  return withVaultLock(boundVaultDir(cfg), deps.lock, async () => {
    const { pds } = await deps.connect(cfg);
    const r = await togglePublic(cfg, args.path, args.makePublic, args.slug, { pds });
    return { ok: true, path: args.path, published: args.makePublic, changed: r.changed, message: r.message, sync: r.summary };
  });
}
```

`packages/cli/src/commands/status.ts`:
```ts
import { boundVaultDir } from '../config';
import { readDaemonState, type DaemonState } from '../daemon-state';
import { readLivePid } from '../pidfile';
import { getVaultStatus, type VaultStatus } from '../session';
import { requireConfig, type CommandDeps } from './context';

export interface DaemonInfo {
  running: boolean;
  pid: number | null;
  connection: DaemonState['connection'] | null;
  lastSyncAt: string | null;
  lastError: string | null;
  lastExit: string | null;
}

export interface StatusResult extends VaultStatus {
  ok: true;
  daemon: DaemonInfo;
}

export async function statusCommand(deps: CommandDeps): Promise<StatusResult> {
  const cfg = await requireConfig(deps);
  const vaultDir = boundVaultDir(cfg);
  const [vault, pid, state] = await Promise.all([
    getVaultStatus(cfg, deps.connect),
    readLivePid(),
    readDaemonState(vaultDir),
  ]);
  const running = pid !== null;
  return {
    ok: true,
    ...vault,
    daemon: {
      running,
      pid,
      connection: running ? (state?.connection ?? null) : null,
      lastSyncAt: state?.lastSyncAt ?? null,
      lastError: state?.lastError ?? null,
      lastExit: running ? null : (state?.lastExit ?? null),
    },
  };
}
```

`packages/cli/src/render.ts`:
```ts
/** Human-readable renderings of command results (the --json form is the raw object). */
import type { PublishResult } from './commands/publish';
import type { StatusResult } from './commands/status';
import type { SyncSummary } from './session';

export function renderSync(r: SyncSummary): string {
  const lines = [`Sync complete: ${r.opsExecuted} operation(s) at ${r.lastSyncAt}.`];
  if (r.warnings.length) {
    lines.push('Warnings:');
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  if (r.skippedPaths.length) lines.push(`Skipped (too large for PDS): ${r.skippedPaths.join(', ')}`);
  return lines.join('\n');
}

export function renderStatus(r: StatusResult): string {
  const d = r.daemon;
  const daemon = d.running
    ? `running (pid ${d.pid}, ${d.connection ?? 'starting'})${d.lastError ? ` — last error: ${d.lastError}` : ''}`
    : `not running${d.lastExit ? ` (last exit: ${d.lastExit})` : ''}`;
  const remote = r.remote
    ? `${r.remote.notes} notes · ${r.remote.attachments} attachments`
    : `unavailable (${r.remoteError ?? 'unknown error'})`;
  return [
    `atpsync: ${r.vaultName ?? '(unknown vault)'} (${r.vaultRkey})`,
    `  account: ${r.identifier} @ ${r.pdsUrl ?? '(resolved from handle)'}`,
    `  vault dir: ${r.vaultDir}`,
    `  local: ${r.localNotes} notes`,
    `  remote: ${remote}`,
    `  last sync: ${d.lastSyncAt ?? r.lastSyncAt ?? 'never'}`,
    `  daemon: ${daemon}`,
  ].join('\n');
}

export function renderPublish(r: PublishResult): string {
  return r.sync ? `${r.message}\n${renderSync(r.sync)}` : r.message;
}
```

Remove `formatSummary` from `session.ts` (now `renderSync`) and fix any import of it: `grep -rn formatSummary packages/cli`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @atproto-sync/cli test && pnpm --filter @atproto-sync/cli typecheck`
Expected: PASS (commands 7 new); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A packages/cli
git commit -m "feat(cli): status/sync/publish command layer with vault lock and text rendering"
```

---

### Task 7: Daemon

**Files:**
- Create: `packages/cli/src/logger.ts`, `packages/cli/src/daemon.ts`
- Test: `packages/cli/test/daemon.test.ts`

**Interfaces:**
- Consumes: `SyncScheduler`, `Trigger`, `SchedulerOptions` (Task 3); `watchVault` (Task 3); `RepoSubscription` (Task 4); `tryAcquireLock` (Task 2); `writePidExclusive`, `removePid` (Task 1); `DaemonStateWriter` (Task 1); `runSync`, `Connect`, `isAuthFailure` (Task 5); `AtpsyncError` (Task 1).
- Produces:
  - `interface Logger { info(m: string): void; warn(m: string): void; error(m: string): void; rotateIfNeeded?(): void }`
  - `createFileLogger(file: string, opts?: { mirror?: { write(s: string): unknown } | null; maxBytes?: number }): Required<Logger>`
  - `interface DaemonDeps { loadConfig(): Promise<AtpsyncConfig>; connect: Connect; clearConnection(): void; log: Logger; signals?: Pick<NodeJS.EventEmitter, 'once' | 'off'>; installCrashHandlers?: boolean; debounceMs?: SchedulerOptions['debounceMs']; subscribedPollMs?: number; subscriptionBackoffMs?: { min: number; max: number } }`
  - `runDaemon(deps: DaemonDeps): Promise<void>` — resolves after SIGTERM/SIGINT and a clean shutdown.

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/daemon.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @atproto-sync/cli exec vitest run test/daemon.test.ts`
Expected: FAIL — cannot resolve `../src/daemon`.

- [ ] **Step 3: Implement the logger**

`packages/cli/src/logger.ts`:
```ts
/** Append-only daemon log with a single size-based rollover (daemon.log → daemon.log.1). */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import * as path from 'node:path';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  rotateIfNeeded?(): void;
}

export function createFileLogger(
  file: string,
  opts: { mirror?: { write(s: string): unknown } | null; maxBytes?: number } = {}
): Required<Logger> {
  mkdirSync(path.dirname(file), { recursive: true });
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const write = (level: string, message: string) => {
    const line = `${new Date().toISOString()} ${level} ${message}\n`;
    try {
      appendFileSync(file, line);
    } catch {
      // Logging must never take the daemon down.
    }
    opts.mirror?.write(line);
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    rotateIfNeeded() {
      try {
        if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
      } catch {
        // missing file: nothing to rotate
      }
    },
  };
}
```

- [ ] **Step 4: Implement the daemon**

`packages/cli/src/daemon.ts`:
```ts
/**
 * The background sync process. Owns one SyncScheduler fed by the fs watcher,
 * the subscribeRepos stream and a poll timer. Each run takes the vault lock
 * without waiting (a held lock means "try again shortly"), syncs, and records
 * the outcome in <vault>/.atpsync/daemon.json for `atpsync status`.
 */
import * as os from 'node:os';
import { isIgnored } from '@atproto-sync/core/sync/ignore';
import { boundVaultDir, isConfigured, type AtpsyncConfig } from './config';
import { DaemonStateWriter } from './daemon-state';
import { AtpsyncError } from './errors';
import { watchVault } from './fs-watch';
import { tryAcquireLock } from './lock';
import type { Logger } from './logger';
import { removePid, writePidExclusive } from './pidfile';
import { SyncScheduler, type SchedulerOptions, type Trigger } from './scheduler';
import { isAuthFailure, runSync, type Connect } from './session';
import { RepoSubscription } from './subscription';

export interface DaemonDeps {
  loadConfig(): Promise<AtpsyncConfig>;
  connect: Connect;
  clearConnection(): void;
  log: Logger;
  signals?: Pick<NodeJS.EventEmitter, 'once' | 'off'>;
  /** Log + record lastExit + remove pidfile on uncaught errors (CLI only; never in tests). */
  installCrashHandlers?: boolean;
  debounceMs?: SchedulerOptions['debounceMs'];
  /** Safety-net poll while the event stream is connected (default 15 min). */
  subscribedPollMs?: number;
  subscriptionBackoffMs?: { min: number; max: number };
}

export async function runDaemon(deps: DaemonDeps): Promise<void> {
  const { log } = deps;
  const signals = deps.signals ?? process;
  const cfg0 = await deps.loadConfig();
  if (!isConfigured(cfg0)) {
    throw new AtpsyncError('NOT_CONFIGURED', 'atpsync is not configured. Run `atpsync setup` first.');
  }
  const vaultDir = boundVaultDir(cfg0);
  await writePidExclusive(process.pid);

  const state = new DaemonStateWriter(vaultDir, {
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
    connection: cfg0.remote === 'subscribe' ? 'reconnecting' : 'poll',
    lastSyncAt: null,
    lastResult: null,
    lastError: null,
    lastExit: null,
  });
  await state.update({});

  if (deps.installCrashHandlers) {
    const fatal = (err: unknown) => {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      log.error(`fatal: ${msg}`);
      void state
        .update({ lastExit: `crashed: ${err instanceof Error ? err.message : String(err)}` })
        .finally(() => removePid(process.pid).finally(() => process.exit(1)));
    };
    process.once('uncaughtException', fatal);
    process.once('unhandledRejection', fatal);
  }

  const slowPollMs = Math.max(1, cfg0.syncIntervalMinutes) * 60_000;
  const subscribedPollMs = deps.subscribedPollMs ?? 15 * 60_000;

  const run = async (reason: Trigger): Promise<'ok' | 'busy'> => {
    const lock = await tryAcquireLock(vaultDir);
    if (!lock) {
      log.info(`sync (${reason}) deferred: vault locked by another atpsync process`);
      return 'busy';
    }
    try {
      const cfg = await deps.loadConfig();
      const { pds } = await deps.connect(cfg);
      const s = await runSync(cfg, { pds });
      log.info(`sync (${reason}): ${s.opsExecuted} operation(s)`);
      for (const w of s.warnings) log.warn(w);
      await state.update({ lastSyncAt: s.lastSyncAt, lastResult: 'ok', lastError: null });
    } catch (err) {
      if (isAuthFailure(err) || (err instanceof AtpsyncError && err.code === 'AUTH')) deps.clearConnection();
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`sync (${reason}) failed: ${msg}`);
      await state.update({ lastResult: 'error', lastError: msg });
    } finally {
      await lock.release();
    }
    return 'ok';
  };

  const scheduler = new SyncScheduler(run, {
    debounceMs: deps.debounceMs,
    onError: (err) => log.error(`scheduler: ${(err as Error).message}`),
  });

  const unwatch = watchVault(
    vaultDir,
    (rel) => isIgnored(rel, cfg0.ignorePatterns),
    () => scheduler.trigger('fs'),
    (m) => log.warn(m)
  );

  let subscription: RepoSubscription | null = null;
  if (cfg0.remote === 'subscribe') {
    subscription = new RepoSubscription({
      resolveTarget: async () => {
        const c = await deps.connect(await deps.loadConfig());
        return { pdsUrl: c.pdsUrl, did: c.did };
      },
      onRelevant: () => scheduler.trigger('remote'),
      onState: (s) => {
        void state.update({ connection: s });
        scheduler.setPollInterval(s === 'subscribed' ? subscribedPollMs : slowPollMs);
        if (s === 'subscribed') {
          log.info('subscribed to PDS event stream');
          scheduler.trigger('startup'); // cover anything missed while disconnected
        }
      },
      log: (m) => log.warn(m),
      minBackoffMs: deps.subscriptionBackoffMs?.min,
      maxBackoffMs: deps.subscriptionBackoffMs?.max,
    });
    subscription.start();
  }

  scheduler.setPollInterval(slowPollMs);
  scheduler.trigger('startup');
  const rotate = setInterval(() => log.rotateIfNeeded?.(), 60 * 60_000);
  rotate.unref();
  log.info(`daemon started (pid ${process.pid}) for ${vaultDir}`);

  await new Promise<void>((resolve) => {
    const onSignal = (sig: string) => {
      signals.off('SIGTERM', onSignal);
      signals.off('SIGINT', onSignal);
      log.info(`received ${sig}, shutting down`);
      resolve();
    };
    signals.once('SIGTERM', onSignal);
    signals.once('SIGINT', onSignal);
  });

  clearInterval(rotate);
  subscription?.stop();
  unwatch();
  await scheduler.stop(); // lets an in-flight sync finish and release the lock
  await state.update({ lastExit: `stopped at ${new Date().toISOString()}` });
  await removePid(process.pid);
  log.info('daemon stopped');
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @atproto-sync/cli exec vitest run test/daemon.test.ts && pnpm --filter @atproto-sync/cli typecheck`
Expected: PASS (5 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/logger.ts packages/cli/src/daemon.ts packages/cli/test/daemon.test.ts
git commit -m "feat(cli): background daemon wiring fs watcher, event stream and polling"
```

---

### Task 8: CLI entry, prompts, build

**Files:**
- Create: `packages/cli/src/cli.ts`, `packages/cli/src/main.ts`, `packages/cli/src/version.ts`, `packages/cli/src/prompts.ts`, `packages/cli/src/commands/logout.ts`, `packages/cli/build.mjs`
- Modify: `packages/cli/package.json`, `packages/cli/src/setup.ts`, root `package.json`
- Test: `packages/cli/test/cli-main.test.ts`

**Interfaces:**
- Consumes: command functions + renderers (Task 6), `runDaemon` (Task 7), `createFileLogger` (Task 7), `runSetup`/`SetupIO` (Phase A), `clearConnectionCache`, `connect` (Task 5).
- Produces:
  - `interface CliIO { stdout(s: string): void; stderr(s: string): void }`
  - `interface CliEnv { io: CliIO; deps: CommandDeps; ctl: StartDeps; cwd: string }` (`StartDeps` is defined in Task 9; in this task declare it in `commands/daemon-control.ts` as `export interface StartDeps { execPath: string; cliPath: string; waitMs?: number }` with no functions yet)
  - `main(argv: string[], env?: CliEnv): Promise<number>` — returns the exit code.
  - `SetupIO.input(title, placeholder?, opts?: { secret?: boolean })` (optional third param).
  - `createTtyIO(cwd: string, vaultDir?: string): SetupIO`
  - `logoutCommand(deps: CommandDeps, stop: () => Promise<{ wasRunning: boolean }>): Promise<{ ok: true; stoppedDaemon: boolean }>`
  - `VERSION: string`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/cli-main.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @atproto-sync/cli exec vitest run test/cli-main.test.ts`
Expected: FAIL — cannot resolve `../src/cli`.

- [ ] **Step 3: Secret prompts in setup**

In `packages/cli/src/setup.ts`:
- `SetupIO.input` becomes `input(title: string, placeholder?: string, opts?: { secret?: boolean }): Promise<string | undefined>;`
- Update the doc comment on `SetupIO` from "The slice of pi's ExtensionContext that setup needs" to "The interactive surface setup needs (TTY prompts in the CLI, fakes in tests)."
- The inner `ask` helper gains a `secret` flag and forwards it:
```ts
  const ask = (title: string, fallbackEnv?: string, secret = false): Promise<string | undefined> => {
    if (!io.hasUI) {
      const v = fallbackEnv ? process.env[fallbackEnv] : undefined;
      return Promise.resolve(v?.trim() ? v.trim() : undefined);
    }
    return io.input(title, undefined, { secret });
  };
```
- The app-password `ask(…, 'ATPSYNC_APP_PASSWORD')` call adds `, true`; `askPassphrase` becomes `(title: string) => ask(title, 'ATPSYNC_PASSPHRASE', true)`.

`packages/cli/src/prompts.ts`:
```ts
/** TTY implementation of SetupIO: readline questions, numbered select, hidden secret input. */
import * as readline from 'node:readline/promises';
import type { SetupIO } from './setup';

function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  return new Promise((resolve, reject) => {
    output.write(prompt);
    let buf = '';
    const wasRaw = input.isRaw;
    input.setRawMode?.(true);
    input.setEncoding('utf8');
    input.resume();
    const finish = () => {
      input.off('data', onData);
      input.setRawMode?.(wasRaw ?? false);
      input.pause();
      output.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          finish();
          reject(new Error('setup aborted'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    input.on('data', onData);
  });
}

async function question(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export function createTtyIO(cwd: string, vaultDir?: string): SetupIO {
  return {
    cwd,
    hasUI: Boolean(process.stdin.isTTY),
    vaultDir,
    async input(title, placeholder, opts) {
      const prompt = `${title}${placeholder ? ` [${placeholder}]` : ''}: `;
      return opts?.secret ? readSecret(prompt) : question(prompt);
    },
    async select(title, options) {
      process.stdout.write(`${title}\n`);
      options.forEach((o, i) => process.stdout.write(`  ${i + 1}) ${o}\n`));
      const n = Number.parseInt(await question(`Choose 1-${options.length}: `), 10);
      return Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : undefined;
    },
    notify(message, type) {
      (type === 'error' ? process.stderr : process.stdout).write(`${message}\n`);
    },
  };
}
```

- [ ] **Step 4: Logout, version, StartDeps stub**

`packages/cli/src/version.ts`:
```ts
export const VERSION = '0.1.0';
```

`packages/cli/src/commands/daemon-control.ts` (Task 9 adds the functions):
```ts
export interface StartDeps {
  /** Node binary used to spawn the daemon. */
  execPath: string;
  /** Path to the CLI entry (the built bundle) the daemon is spawned from. */
  cliPath: string;
  /** How long `start` waits for the daemon to come up (default 3000 ms). */
  waitMs?: number;
}
```

`packages/cli/src/commands/logout.ts`:
```ts
import { saveConfig } from '../config';
import { clearConnectionCache } from '../session';
import type { CommandDeps } from './context';

/** Stop the daemon, then forget the app password and cached master key. The vault binding stays. */
export async function logoutCommand(
  deps: CommandDeps,
  stop: () => Promise<{ wasRunning: boolean }>
): Promise<{ ok: true; stoppedDaemon: boolean }> {
  const { wasRunning } = await stop();
  const cfg = await deps.loadConfig();
  await saveConfig({ ...cfg, appPassword: '', masterKeyB64: '' });
  clearConnectionCache();
  return { ok: true, stoppedDaemon: wasRunning };
}
```

- [ ] **Step 5: CLI dispatcher**

`packages/cli/src/cli.ts`:
```ts
/** Argument parsing, dispatch, text vs --json output, and exit codes. */
import { parseArgs } from 'node:util';
import { defaultDeps, type CommandDeps } from './commands/context';
import type { StartDeps } from './commands/daemon-control';
import { logoutCommand } from './commands/logout';
import { publishCommand } from './commands/publish';
import { statusCommand } from './commands/status';
import { syncCommand } from './commands/sync';
import { loadConfig } from './config';
import { runDaemon } from './daemon';
import { AtpsyncError, EXIT_CODES, toAtpsyncError } from './errors';
import { createFileLogger } from './logger';
import { logPath } from './paths';
import { createTtyIO } from './prompts';
import { renderPublish, renderStatus, renderSync } from './render';
import { clearConnectionCache, connect } from './session';
import { runSetup } from './setup';
import { VERSION } from './version';

export interface CliIO {
  stdout(s: string): void;
  stderr(s: string): void;
}

export interface CliEnv {
  io: CliIO;
  deps: CommandDeps;
  ctl: StartDeps;
  cwd: string;
}

export const USAGE = `atpsync ${VERSION} — sync a vault folder with your ATProto PDS (E2E-encrypted)

Usage:
  atpsync setup [folder]            sign in, bind a folder, choose/create a vault
  atpsync start                     start the background daemon
  atpsync stop                      stop the background daemon
  atpsync status [--json]           account, vault, counts, daemon state
  atpsync sync [--json] [--no-wait] sync once now
  atpsync publish <path> [slug]     make a note public, then sync
  atpsync unpublish <path>          make a note private again, then sync
  atpsync logs [-f]                 print (or follow) the daemon log
  atpsync logout                    stop the daemon and forget credentials
  atpsync daemon                    run the daemon in the foreground
  atpsync mcp                       MCP server on stdio (for agents)`;

export function defaultEnv(): CliEnv {
  return {
    io: { stdout: (s) => void process.stdout.write(s), stderr: (s) => void process.stderr.write(s) },
    deps: defaultDeps(),
    ctl: { execPath: process.execPath, cliPath: process.argv[1] },
    cwd: process.cwd(),
  };
}

export async function main(argv: string[], env: CliEnv = defaultEnv()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean' },
        'no-wait': { type: 'boolean' },
        follow: { type: 'boolean', short: 'f' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    env.io.stderr(`atpsync: ${(err as Error).message}\n\n${USAGE}\n`);
    return EXIT_CODES.USAGE;
  }
  const { values, positionals } = parsed;
  const [cmd = 'help', ...rest] = values.help ? ['help'] : values.version ? ['version'] : positionals;
  const json = Boolean(values.json);
  const deps: CommandDeps = values['no-wait'] ? { ...env.deps, lock: { ...env.deps.lock, wait: false } } : env.deps;
  const emit = (result: unknown, text: string) => env.io.stdout(`${json ? JSON.stringify(result) : text}\n`);

  try {
    switch (cmd) {
      case 'help':
        env.io.stdout(`${USAGE}\n`);
        return 0;
      case 'version':
        env.io.stdout(`${VERSION}\n`);
        return 0;
      case 'status': {
        const r = await statusCommand(deps);
        emit(r, renderStatus(r));
        return 0;
      }
      case 'sync': {
        const r = await syncCommand(deps);
        emit(r, renderSync(r));
        return 0;
      }
      case 'publish':
      case 'unpublish': {
        const target = rest[0];
        if (!target) throw new AtpsyncError('USAGE', `usage: atpsync ${cmd} <path>${cmd === 'publish' ? ' [slug]' : ''}`);
        const r = await publishCommand(deps, {
          path: target,
          makePublic: cmd === 'publish',
          slug: cmd === 'publish' ? rest[1] : undefined,
        });
        emit(r, renderPublish(r));
        return 0;
      }
      case 'logout': {
        // Task 9 replaces this stub with `() => stopCommand()`.
        const r = await logoutCommand(deps, async () => ({ wasRunning: false }));
        emit(r, `Logged out${r.stoppedDaemon ? ' (daemon stopped)' : ''}. Run \`atpsync setup\` to sign back in.`);
        return 0;
      }
      case 'setup':
        await runSetup(createTtyIO(env.cwd, rest.join(' ') || undefined));
        clearConnectionCache();
        return 0;
      case 'daemon': {
        const log = createFileLogger(logPath(), { mirror: process.stdout.isTTY ? process.stdout : null });
        log.rotateIfNeeded();
        await runDaemon({
          loadConfig,
          connect: (cfg) => connect(cfg),
          clearConnection: clearConnectionCache,
          log,
          installCrashHandlers: true,
        });
        return 0;
      }
      // 'start' | 'stop' | 'logs' are added in Task 9; 'mcp' in Task 10.
      default:
        throw new AtpsyncError('USAGE', `Unknown command "${cmd}".\n\n${USAGE}`);
    }
  } catch (err) {
    const e = toAtpsyncError(err);
    if (json) env.io.stdout(`${JSON.stringify({ ok: false, error: { code: e.code, message: e.message } })}\n`);
    else env.io.stderr(`atpsync: ${e.message}\n`);
    return EXIT_CODES[e.code];
  }
}
```

`packages/cli/src/main.ts`:
```ts
import { main } from './cli';

const argv = process.argv.slice(2);
main(argv).then((code) => {
  // The daemon resolves only after shutdown; exit explicitly so no stray handle keeps it alive.
  if (argv[0] === 'daemon') process.exit(code);
  process.exitCode = code;
});
```

- [ ] **Step 6: Build and package wiring**

`packages/cli/build.mjs`:
```js
import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/atpsync.cjs',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
```

`packages/cli/package.json`: add
```json
  "bin": { "atpsync": "dist/atpsync.cjs" },
```
and in `scripts` add `"build": "node build.mjs"`.

Root `package.json` `scripts`: add `"build:cli": "pnpm --filter @atproto-sync/cli build"`.

- [ ] **Step 7: Run tests and smoke the bundle**

Run (the temp dirs keep the smoke test away from any real `~/.config/atpsync`):
```bash
pnpm --filter @atproto-sync/cli test && pnpm --filter @atproto-sync/cli typecheck && pnpm run build:cli
node packages/cli/dist/atpsync.cjs --version
ATPSYNC_CONFIG_DIR=$(mktemp -d) ATPSYNC_STATE_DIR=$(mktemp -d) node packages/cli/dist/atpsync.cjs status --json; echo "exit=$?"
```
Expected: tests pass (cli-main 7 new); typecheck clean; prints `0.1.0`; then `{"ok":false,"error":{"code":"NOT_CONFIGURED",…}}` and `exit=3`.

- [ ] **Step 8: Commit**

```bash
git add -A packages/cli package.json pnpm-lock.yaml
git commit -m "feat(cli): atpsync entry point with --json output, exit codes, TTY setup and bundle"
```

---

### Task 9: `start`, `stop`, `logs` and lifecycle e2e

**Files:**
- Modify: `packages/cli/src/commands/daemon-control.ts`, `packages/cli/src/cli.ts`
- Create: `packages/cli/src/commands/logs.ts`
- Test: `packages/cli/test/daemon.e2e.test.ts`

**Interfaces:**
- Consumes: `readLivePid`, `isAlive`, `removePid` (Task 1), `readDaemonState` (Task 1), `requireConfig` (Task 6), `StartDeps` (Task 8).
- Produces:
  - `startCommand(deps: CommandDeps, ctl: StartDeps): Promise<{ ok: true; pid: number; logPath: string }>` (throws `ALREADY_RUNNING`)
  - `stopCommand(opts?: { graceMs?: number }): Promise<{ ok: true; wasRunning: boolean; pid: number | null; forced: boolean }>`
  - `tailLog(lines: number): Promise<string>`
  - `logsCommand(opts: { follow: boolean; write(s: string): void; signal?: AbortSignal }): Promise<void>`

- [ ] **Step 1: Write the failing e2e test**

`packages/cli/test/daemon.e2e.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @atproto-sync/cli exec vitest run test/daemon.e2e.test.ts`
Expected: FAIL — `start` is an unknown command (exit 2).

- [ ] **Step 3: Implement**

`packages/cli/src/commands/daemon-control.ts` (keep the `StartDeps` interface from Task 8, add below it):
```ts
import { spawn } from 'node:child_process';
import { closeSync, openSync, promises as fs } from 'node:fs';
import { boundVaultDir } from '../config';
import { readDaemonState } from '../daemon-state';
import { AtpsyncError } from '../errors';
import { logPath, stateDir } from '../paths';
import { isAlive, readLivePid, removePid } from '../pidfile';
import { requireConfig, type CommandDeps } from './context';
import { tailLog } from './logs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spawn `atpsync daemon` detached and wait until it has claimed the pidfile and written daemon.json. */
export async function startCommand(
  deps: CommandDeps,
  ctl: StartDeps
): Promise<{ ok: true; pid: number; logPath: string }> {
  const cfg = await requireConfig(deps);
  const vaultDir = boundVaultDir(cfg);
  const live = await readLivePid();
  if (live !== null) throw new AtpsyncError('ALREADY_RUNNING', `atpsync daemon is already running (pid ${live}).`);

  await fs.mkdir(stateDir(), { recursive: true });
  const fd = openSync(logPath(), 'a');
  const child = spawn(ctl.execPath, [ctl.cliPath, 'daemon'], {
    detached: true,
    stdio: ['ignore', 'ignore', fd],
    env: process.env,
  });
  closeSync(fd);
  let exitCode: number | null = null;
  child.once('exit', (code) => {
    exitCode = code ?? 1;
  });
  child.unref();

  const deadline = Date.now() + (ctl.waitMs ?? 3000);
  while (Date.now() < deadline && exitCode === null) {
    if ((await readLivePid()) === child.pid && (await readDaemonState(vaultDir))?.pid === child.pid) {
      return { ok: true, pid: child.pid!, logPath: logPath() };
    }
    await sleep(100);
  }
  const why = exitCode !== null ? ` (exited with code ${exitCode})` : ' (timed out)';
  throw new AtpsyncError('ERROR', `The daemon failed to start${why}. Last log lines:\n${await tailLog(20)}`);
}

/** SIGTERM the daemon, wait up to graceMs (default 10 s), then SIGKILL. */
export async function stopCommand(
  opts: { graceMs?: number } = {}
): Promise<{ ok: true; wasRunning: boolean; pid: number | null; forced: boolean }> {
  const pid = await readLivePid();
  if (pid === null) return { ok: true, wasRunning: false, pid: null, forced: false };
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + (opts.graceMs ?? 10_000);
  while (Date.now() < deadline && isAlive(pid)) await sleep(100);
  let forced = false;
  if (isAlive(pid)) {
    forced = true;
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 10 && isAlive(pid); i++) await sleep(100);
  }
  await removePid(pid);
  return { ok: true, wasRunning: true, pid, forced };
}
```

`packages/cli/src/commands/logs.ts`:
```ts
import { promises as fs, watchFile, unwatchFile } from 'node:fs';
import { logPath } from '../paths';

export async function tailLog(lines: number): Promise<string> {
  try {
    const text = await fs.readFile(logPath(), 'utf8');
    return text.split('\n').filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '(no daemon log yet)';
  }
}

/** Print the last 200 lines; with follow, keep printing appended bytes until aborted / SIGINT. */
export async function logsCommand(opts: { follow: boolean; write(s: string): void; signal?: AbortSignal }): Promise<void> {
  opts.write(`${await tailLog(200)}\n`);
  if (!opts.follow) return;
  const file = logPath();
  let offset = (await fs.stat(file).catch(() => ({ size: 0 }))).size;
  const onChange = async () => {
    const { size } = await fs.stat(file).catch(() => ({ size: 0 }));
    if (size < offset) offset = 0; // rotated
    if (size === offset) return;
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      await fh.read(buf, 0, buf.length, offset);
      offset = size;
      opts.write(buf.toString('utf8'));
    } finally {
      await fh.close();
    }
  };
  watchFile(file, { interval: 500 }, () => void onChange());
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    opts.signal?.addEventListener('abort', done, { once: true });
    process.once('SIGINT', done);
  });
  unwatchFile(file);
}
```

In `packages/cli/src/cli.ts`:
- import `startCommand`, `stopCommand` from `./commands/daemon-control` (extend the existing `StartDeps` type import) and `logsCommand` from `./commands/logs`.
- in the `logout` case replace the stub with `const r = await logoutCommand(deps, () => stopCommand());` and delete the `// Task 9 replaces…` comment.
- add cases before `default`:
```ts
      case 'start': {
        const r = await startCommand(deps, env.ctl);
        emit(r, `atpsync daemon started (pid ${r.pid}). Logs: ${r.logPath}`);
        return 0;
      }
      case 'stop': {
        const r = await stopCommand();
        emit(r, r.wasRunning ? `atpsync daemon stopped (pid ${r.pid}${r.forced ? ', killed after timeout' : ''}).` : 'atpsync daemon is not running.');
        return 0;
      }
      case 'logs':
        await logsCommand({ follow: Boolean(values.follow), write: env.io.stdout });
        return 0;
```
- remove the `// 'start' | 'stop' | 'logs' are added in Task 9` comment.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @atproto-sync/cli test && pnpm --filter @atproto-sync/cli typecheck`
Expected: all cli tests pass including the 4 e2e tests; typecheck clean. If the e2e `start` fails, its assertion message includes the CLI's stdout+stderr (which contains the log tail).

- [ ] **Step 5: Commit**

```bash
git add -A packages/cli
git commit -m "feat(cli): self-daemonizing start/stop with pidfile checks, logs command, lifecycle e2e"
```

---

### Task 10: MCP server

**Files:**
- Create: `packages/cli/src/mcp.ts`
- Modify: `packages/cli/package.json` (deps), `packages/cli/src/cli.ts` (`mcp` case, usage unchanged)
- Test: `packages/cli/test/mcp.test.ts`

**Interfaces:**
- Consumes: `statusCommand`, `syncCommand`, `publishCommand`, `startCommand`, `stopCommand`, renderers, `CommandDeps`, `StartDeps`, `toAtpsyncError`, `VERSION`.
- Produces: `MCP_INSTRUCTIONS: string`; `createMcpServer(deps: CommandDeps, ctl: StartDeps): McpServer`; `runMcp(deps, ctl): Promise<void>`.

- [ ] **Step 1: Add dependencies**

Run: `pnpm --filter @atproto-sync/cli add @modelcontextprotocol/sdk@^1.32.1 zod@^4.6.7`

- [ ] **Step 2: Write the failing tests**

`packages/cli/test/mcp.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FakePds } from '@atproto-sync/core/sync/fake-pds';
import { DEFAULT_CONFIG, saveConfig, type AtpsyncConfig } from '../src/config';
import { createMcpServer } from '../src/mcp';
import { clearAtpsyncEnv, configuredCfg, tempEnv } from './helpers';

afterEach(clearAtpsyncEnv);

async function connected(cfg: AtpsyncConfig, pds = new FakePds()) {
  const server = createMcpServer(
    {
      loadConfig: async () => cfg,
      connect: async () => ({ pds, did: 'did:plc:me', pdsUrl: 'http://fake' }),
      lock: { wait: true, timeoutMs: 1000 },
    },
    { execPath: process.execPath, cliPath: '/nonexistent' }
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return client;
}

describe('MCP server', () => {
  it('lists the five tools and tells agents the daemon syncs automatically', async () => {
    await tempEnv();
    const client = await connected({ ...DEFAULT_CONFIG });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'atpsync_daemon', 'atpsync_publish', 'atpsync_status', 'atpsync_sync', 'atpsync_unpublish',
    ]);
    expect(tools.find((t) => t.name === 'atpsync_status')?.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toMatch(/automatically/);
  });

  it('returns structured results and text', async () => {
    const { vaultDir } = await tempEnv();
    const cfg = await configuredCfg(vaultDir);
    await saveConfig(cfg);
    const pds = new FakePds();
    await fs.writeFile(path.join(vaultDir, 'post.md'), 'hello world');
    const client = await connected(cfg, pds);

    const pub = await client.callTool({ name: 'atpsync_publish', arguments: { path: 'post.md', slug: 'hi' } });
    expect(pub.isError).toBeFalsy();
    expect(pub.structuredContent).toMatchObject({ ok: true, published: true, changed: true });
    expect(JSON.stringify(pub.content)).toMatch(/now public/);

    const st = await client.callTool({ name: 'atpsync_status', arguments: {} });
    expect(st.structuredContent).toMatchObject({ ok: true, localNotes: 1, daemon: { running: false } });
    expect(JSON.stringify(st)).not.toContain(cfg.appPassword);
  });

  it('reports errors with their code', async () => {
    await tempEnv();
    const client = await connected({ ...DEFAULT_CONFIG });
    const r = await client.callTool({ name: 'atpsync_sync', arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED' } });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @atproto-sync/cli exec vitest run test/mcp.test.ts`
Expected: FAIL — cannot resolve `../src/mcp`.

- [ ] **Step 4: Implement**

`packages/cli/src/mcp.ts`:
```ts
/** MCP server over stdio exposing the same command functions as the CLI. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CommandDeps } from './commands/context';
import { startCommand, stopCommand, type StartDeps } from './commands/daemon-control';
import { publishCommand } from './commands/publish';
import { statusCommand } from './commands/status';
import { syncCommand } from './commands/sync';
import { toAtpsyncError } from './errors';
import { renderPublish, renderStatus, renderSync } from './render';
import { VERSION } from './version';

export const MCP_INSTRUCTIONS =
  'atpsync keeps a local vault folder in sync with the user\'s ATProto PDS (end-to-end encrypted). ' +
  'When the atpsync daemon is running it syncs edits automatically: just edit files in the vault. ' +
  'Call atpsync_sync only when a sync must happen right now, and atpsync_status to check the vault and daemon.';

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

async function respond<T extends object>(fn: () => Promise<T>, render: (r: T) => string): Promise<ToolResult> {
  try {
    const r = await fn();
    return { content: [{ type: 'text', text: render(r) }], structuredContent: r as unknown as Record<string, unknown> };
  } catch (err) {
    const e = toAtpsyncError(err);
    return {
      content: [{ type: 'text', text: `${e.code}: ${e.message}` }],
      structuredContent: { ok: false, error: { code: e.code, message: e.message } },
      isError: true,
    };
  }
}

export function createMcpServer(deps: CommandDeps, ctl: StartDeps): McpServer {
  const server = new McpServer({ name: 'atpsync', version: VERSION }, { instructions: MCP_INSTRUCTIONS });

  server.registerTool(
    'atpsync_status',
    {
      description:
        'Show atpsync state: account, vault, local vs remote note/attachment counts, last sync time, and whether the background daemon is running.',
      annotations: { readOnlyHint: true },
    },
    () => respond(() => statusCommand(deps), renderStatus)
  );

  server.registerTool(
    'atpsync_sync',
    {
      description:
        'Sync the vault folder with the PDS now (E2E-encrypted, bidirectional). Usually unnecessary while the daemon runs; use it when a sync must happen immediately.',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    () => respond(() => syncCommand(deps), renderSync)
  );

  server.registerTool(
    'atpsync_publish',
    {
      description:
        'Mark a vault note as public (plaintext on the PDS, addressable by slug) and sync. Public notes and the attachments they embed become visible to anyone with the link.',
      inputSchema: {
        path: z.string().describe('Vault-relative path of the markdown note, e.g. "blog/my-post.md".'),
        slug: z.string().optional().describe('Public URL slug. Defaults to the note title.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    ({ path, slug }) => respond(() => publishCommand(deps, { path, slug, makePublic: true }), renderPublish)
  );

  server.registerTool(
    'atpsync_unpublish',
    {
      description: 'Mark a public vault note private again (re-encrypted, key rotated) and sync.',
      inputSchema: { path: z.string().describe('Vault-relative path of the markdown note to unpublish.') },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    ({ path }) => respond(() => publishCommand(deps, { path, makePublic: false }), renderPublish)
  );

  server.registerTool(
    'atpsync_daemon',
    {
      description: 'Start or stop the atpsync background daemon that keeps the vault synced automatically.',
      inputSchema: { action: z.enum(['start', 'stop']) },
      annotations: { readOnlyHint: false },
    },
    ({ action }) =>
      action === 'start'
        ? respond(() => startCommand(deps, ctl), (r) => `atpsync daemon started (pid ${r.pid}).`)
        : respond(() => stopCommand(), (r) => (r.wasRunning ? `atpsync daemon stopped (pid ${r.pid}).` : 'atpsync daemon is not running.'))
  );

  return server;
}

export async function runMcp(deps: CommandDeps, ctl: StartDeps): Promise<void> {
  await createMcpServer(deps, ctl).connect(new StdioServerTransport());
}
```

In `packages/cli/src/cli.ts` add `import { runMcp } from './mcp';` and, before `default`:
```ts
      case 'mcp':
        await runMcp(deps, env.ctl);
        return 0;
```
Remove the `'mcp' in Task 10` part of the leftover comment.

- [ ] **Step 5: Run to verify pass, and smoke the bundled server**

Run:
```bash
pnpm --filter @atproto-sync/cli test && pnpm --filter @atproto-sync/cli typecheck && pnpm run build:cli
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  | ATPSYNC_CONFIG_DIR=$(mktemp -d) timeout 5 node packages/cli/dist/atpsync.cjs mcp | head -c 400; echo
```
Expected: tests pass (mcp 3 new); typecheck clean; the smoke prints a JSON-RPC result containing `"name":"atpsync"` and the instructions text. If the CJS bundle fails to load an ESM-only dependency, the error appears here — fix by adding `mainFields: ['module', 'main']` to `build.mjs` and re-run.

- [ ] **Step 6: Commit**

```bash
git add -A packages/cli pnpm-lock.yaml
git commit -m "feat(cli): MCP server exposing status/sync/publish/unpublish/daemon tools"
```

---

### Task 11: Docs and optional live test

**Files:**
- Create: `packages/cli/README.md`, `packages/cli/test/subscription-live.integration.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Live subscription test (env-gated, same env vars as the existing core live test)**

`packages/cli/test/subscription-live.integration.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { login } from '@atproto-sync/core/atproto/pds-client';
import { RepoSubscription } from '../src/subscription';
import { waitFor } from './helpers';

const url = process.env.NOTESKY_PDS_URL;
const handle = process.env.NOTESKY_HANDLE;
const password = process.env.NOTESKY_PASSWORD;

describe.skipIf(!url || !handle || !password)('subscribeRepos against a live PDS', () => {
  it('reports our own notesky write within a few seconds', async () => {
    const pds = await login({ identifier: handle!, password: password!, pdsUrl: url! });
    let relevant = 0;
    let subscribed = false;
    const sub = new RepoSubscription({
      resolveTarget: async () => ({ pdsUrl: url!, did: pds.did }),
      onRelevant: () => relevant++,
      onState: (s) => (subscribed = s === 'subscribed'),
    });
    sub.start();
    try {
      await waitFor(() => subscribed, 5000);
      const rkey = `live${Date.now().toString(36)}`;
      await pds.putRecord('app.notesky.tombstone', rkey, { $type: 'app.notesky.tombstone', vault: 'live-test', deletedAt: new Date().toISOString() }, null);
      await waitFor(() => relevant > 0, 10_000);
      await pds.deleteRecord('app.notesky.tombstone', rkey);
    } finally {
      sub.stop();
    }
    expect(relevant).toBeGreaterThan(0);
  }, 30_000);
});
```
Run: `pnpm --filter @atproto-sync/cli exec vitest run test/subscription-live.integration.test.ts`
Expected: skipped without env. With the Docker PDS from `docs/manual-testing.md` and `NOTESKY_*` set: PASS. (If the tombstone record shape is rejected by the PDS, copy the shape the core live test writes; `validate: false` is already set for creates in `RealPdsClient`.)

- [ ] **Step 2: `packages/cli/README.md`**

Write it with these sections and exact content:

```markdown
# atpsync

Sync a plain vault folder (Obsidian-compatible markdown + attachments) with your ATProto PDS,
end-to-end encrypted, without Obsidian. Any editor or coding agent can work in the folder;
a background daemon keeps it in sync.

## Install

    pnpm install
    pnpm run build:cli
    cd packages/cli && pnpm link --global      # puts `atpsync` on your PATH

## First run

    atpsync setup ~/notes      # handle, app password, vault, passphrase
    atpsync start              # background daemon
    atpsync status

To start the daemon at login, add `atpsync start` to your shell profile or desktop session's
autostart. `atpsync start` is a no-op error (exit 1, "already running") if it is up.

## How it syncs

- Local edits: file changes are picked up within ~2 s.
- Remote edits: the daemon listens to your own PDS's event stream (`subscribeRepos`) and pulls
  within about a second. If the stream is unavailable it polls every `syncIntervalMinutes`
  (default 1). Set `"remote": "poll"` in the config to disable the stream.
- Several atpsync processes (daemon, `atpsync sync`, MCP) coordinate through
  `<vault>/.atpsync/lock`.

## Commands

| Command | |
| --- | --- |
| `atpsync setup [folder]` | sign in, bind a folder, choose/create a vault |
| `atpsync start` / `stop` | background daemon |
| `atpsync status` | account, vault, counts, daemon state |
| `atpsync sync [--no-wait]` | sync once now |
| `atpsync publish <path> [slug]` / `unpublish <path>` | toggle a note public/private, then sync |
| `atpsync logs [-f]` | daemon log |
| `atpsync logout` | stop the daemon and forget credentials |
| `atpsync daemon` | run the daemon in the foreground (for systemd/launchd if you prefer) |
| `atpsync mcp` | MCP server on stdio |

Every reporting command accepts `--json`. Exit codes: 0 ok, 1 error, 2 usage, 3 not
configured, 4 vault busy (lock timeout), 5 sign-in failed.

## Files

- `~/.config/atpsync/config.json` (0600) — account, app password, vault binding, cached key
- `~/.local/state/atpsync/daemon.{pid,log}` — daemon pid and log
- `<vault>/.atpsync/` — sync index, lock, daemon status (never synced)

Environment overrides: `ATPSYNC_CONFIG_DIR`, `ATPSYNC_STATE_DIR`, `ATPSYNC_VAULT_DIR`.
Headless setup reads `ATPSYNC_HANDLE`, `ATPSYNC_APP_PASSWORD`, `ATPSYNC_PASSPHRASE`, and
`ATPSYNC_VAULT_RKEY` or `ATPSYNC_VAULT_NAME`.

## Using it from agents

MCP (any MCP-capable agent), e.g. Claude Code:

    claude mcp add atpsync -- atpsync mcp

Tools: `atpsync_status`, `atpsync_sync`, `atpsync_publish`, `atpsync_unpublish`, `atpsync_daemon`.

Or paste this into your agent's instructions file (AGENTS.md, CLAUDE.md, …):

> The folder `~/notes` is a vault synced to my ATProto PDS by `atpsync`. Edit files there
> normally; the atpsync daemon syncs changes automatically. To check sync state run
> `atpsync status --json`. To make a note public run `atpsync publish <path> [slug]`
> (and `atpsync unpublish <path>` to revert). Do not edit files under `.atpsync/`.
```

- [ ] **Step 3: Root README**

Add a section after "Notes on limits":

```markdown
## Command-line sync (without Obsidian)

[`packages/cli`](packages/cli/README.md) provides `atpsync`, a CLI and background daemon that
keeps a plain vault folder in sync using the same engine, encryption and record layout as the
plugin. It reacts to remote changes in real time through your PDS's event stream, and works
with any editor or coding agent (CLI with `--json`, or `atpsync mcp`). App-password auth;
config in `~/.config/atpsync/`.
```

- [ ] **Step 4: Full verification**

Run: `pnpm run typecheck && pnpm test && pnpm run build && pnpm run build:cli && git status --short`
Expected: everything passes; `git status` shows only the files from this task.

- [ ] **Step 5: Commit**

```bash
git add README.md packages/cli/README.md packages/cli/test/subscription-live.integration.test.ts
git commit -m "docs(cli): atpsync README, agent setup, live subscription test"
```
