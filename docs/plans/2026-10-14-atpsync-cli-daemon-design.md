# atpsync CLI + daemon (replaces the pi extension)

**Status:** approved 2026-10-14. Replaces `pi-extension/`.

## Problem

The pi extension runs the sync engine against a plain vault directory, but only
inside a pi session: the watcher dies when pi exits, and only pi can drive it.
Vaults edited by other agents (Claude Code, Codex, …) or plain editors have no
background sync. Remote changes are only discovered by polling every 5 min.

## Decision

An agent-agnostic `atpsync` CLI with a self-daemonizing background sync
process, a real-time remote listener, and an MCP server — built in a repo
restructured into pnpm workspaces. Agents just edit files; the daemon syncs.

Work lands in two phases, each with its own implementation plan:

- **Phase A — monorepo restructure** (mechanical, no behavior change).
- **Phase B — CLI, daemon, MCP** on top of the extracted core.

Scope: one vault per daemon (matches the existing config). The Obsidian plugin's
behavior is unchanged.

## Phase A: monorepo layout

pnpm workspaces:

- `packages/core` — `sync/`, `crypto/`, `lexicon/`, `publish/`, plus
  `pds-client.ts` and `ignore.ts` moved out of `src/obsidian/` (neither depends
  on Obsidian). `lexicons/` moves here too.
- `packages/obsidian` — the plugin (`src/obsidian/*` minus the moved files),
  its esbuild config. `styles.css` stays at the repo root and the build writes `main.js` to the repo root, so the plugin dev symlink and release asset paths are unchanged.
- `packages/cli` — the new tool (Phase B).

Constraints:

- Obsidian's community updater reads `manifest.json` and `versions.json` from
  the **repo root**; they stay there. The plugin build reads the root
  `manifest.json`. The release workflow is unchanged apart from the pnpm version.
- Tests move with their code (`tests/{crypto,lexicon,publish,sync}` →
  `packages/core/test`, `tests/obsidian` → split by where the module lands).
- Phase A also moves the pi extension's plain-Node modules into `packages/cli/src/` and deletes `pi-extension/index.ts` and the pi dependencies; Phase B builds the CLI on those modules.

Acceptance: `pnpm -r typecheck` and `pnpm -r test` pass; the plugin build
produces a functionally identical `main.js`; the release workflow still
validates against the root `manifest.json`.

## Phase B: CLI surface

`atpsync <command>`; every reporting command accepts `--json`.

| Command | Behavior |
| --- | --- |
| `setup [folder]` | TTY prompts (readline): handle, app password, folder, choose/create vault, passphrase. Non-TTY reads the existing `ATPSYNC_*` env vars. |
| `start` | Spawn the daemon detached. Refuses if the pidfile names a live process. |
| `stop` | SIGTERM, wait up to 10 s, then SIGKILL; remove pidfile. |
| `daemon` | Run the daemon in the foreground (what `start` spawns; also usable under a supervisor). |
| `status` | Account, vault, dir, local/remote counts, last sync, daemon running/pid, connection mode. |
| `sync` | One sync now, under the vault lock. |
| `publish <path> [slug]` / `unpublish <path>` | Flip frontmatter, then sync, under the lock. |
| `logs [-f]` | Print or follow the daemon log. |
| `logout` | Clear app password + cached master key; stop the daemon. |
| `mcp` | MCP server on stdio. |

Argument parsing uses `node:util` `parseArgs` (no framework dependency).

## Daemon lifecycle

- `start` spawns `process.execPath <cli> daemon` with `detached: true`, stdio to
  the log file, `unref()`. It waits up to 3 s for the pidfile and `daemon.json`
  to appear; on failure it prints the log tail and exits 1.
- Pidfile and log: `$XDG_STATE_HOME/atpsync/daemon.pid` and `daemon.log`
  (default `~/.local/state/atpsync/`, override `ATPSYNC_STATE_DIR`). Per
  machine, not in the vault, because the vault folder may be shared storage.
- Log rotation: one rollover to `daemon.log.1` above 5 MB, checked at startup
  and hourly.
- Stale pidfile: `process.kill(pid, 0)` → ESRCH means stale; remove and proceed.
- SIGTERM/SIGINT: finish any in-flight sync (never abort mid-write), close the
  websocket and watcher, release the lock, remove the pidfile, exit 0.
- No auto-restart. An unhandled error is logged, recorded as `lastExit` in
  `daemon.json`, and the process exits; `status` reports
  "not running (last exit: …)". The README documents adding `atpsync start` to
  a login script.

`<vault>/.atpsync/daemon.json` is written by the daemon after every state
change: `{ pid, host, startedAt, connection: "subscribed"|"reconnecting"|"poll",
lastSyncAt, lastResult, lastError, lastExit }`. `.atpsync/` is already ignored.

## Sync triggers

A single `SyncScheduler` (evolved from `watcher.ts`) owns every trigger:

| Trigger | Debounce |
| --- | --- |
| `startup` (daemon start, websocket (re)connect) | none |
| `fs` (recursive `fs.watch`, ignored paths dropped) | 2 s |
| `remote` (subscription event) | 500 ms |
| `poll` | none |

One sync at a time. A trigger during a sync sets `pending`; after the sync, a
pending run is rescheduled through the debounce so our own writes settle. Each
run acquires the vault lock without waiting; if it is held, the run becomes
`pending`. After each run `daemon.json` is updated.

Polling interval: 15 min while subscribed; `syncIntervalMinutes` while disconnected
or in `poll` mode. The default for new configs drops from 5 to 1; existing
configs keep their saved value.

## Remote listener (`subscribeRepos`)

- Connects to `wss://<pds>/xrpc/com.atproto.sync.subscribeRepos` with Node 22's
  global `WebSocket`, using the PDS URL already resolved for login.
- Each binary frame is two concatenated DAG-CBOR values (header, body), decoded
  with `@ipld/dag-cbor`. A `#commit` body with `repo === <our DID>` and any
  `ops[].path` starting with `app.notesky.` fires a `remote` trigger. CAR blocks
  are never parsed and signatures are not verified: an event is only a hint;
  the engine re-reads records over XRPC, so a forged event costs at most an
  extra sync.
- No persisted cursor: every connect fires a `startup` sync, covering any gap.
- Reconnect with exponential backoff, 1 s → 60 s, with jitter. `#info` frames
  are ignored; error frames and socket errors trigger reconnect.
- A PDS stream carries every repo on that host; only the header and `repo` are
  inspected per frame. Config `remote: "subscribe" | "poll"` (default
  `subscribe`) disables the listener if volume is a problem.
- Our own writes echo back as commits and cause one no-op sync; accepted.

## Vault lock

`<vault>/.atpsync/lock`, created with O_EXCL, containing
`{ pid, host, startedAt }`. The holder touches its mtime every 30 s.

A lock is stale if (`host` is this machine and `pid` is dead) or its mtime is
older than 2 min; stale locks are removed and acquisition retried.

One-shot CLI and MCP operations wait up to 60 s (`--no-wait` fails
immediately) and then fail with exit code 4. The daemon never waits.

## Command layer, output, errors

Each command is implemented once in `packages/cli/src/commands/` as an async
function returning a typed result or throwing `AtpsyncError { code, message }`.
Three thin renderers:

- CLI text formatter per result.
- `--json`: the result object on stdout; errors as
  `{"ok":false,"error":{"code","message"}}` on stdout.
- MCP: `content` = text rendering, `structuredContent` = result; errors set
  `isError: true`.

Exit codes: `0` ok · `1` error · `2` usage · `3` not configured · `4` lock
timeout · `5` auth failed. Sync warnings (e.g. skipped oversized files) are
reported in the result and still exit 0.

The app password and master key never appear in logs, JSON, or MCP output.

## MCP server

`atpsync mcp` uses `@modelcontextprotocol/sdk` over stdio. Tools:
`atpsync_status` (read-only), `atpsync_sync`, `atpsync_publish {path, slug?}`,
`atpsync_unpublish {path}`, `atpsync_daemon {action: "start"|"stop"}`.
Descriptions carry over from the pi tools. The server `instructions` state that
the daemon syncs edits automatically and `atpsync_sync` is only needed to force
an immediate sync. `setup` and `logout` are not exposed (interactive /
destructive; human-only).

The CLI README includes a paste-able snippet for any agent's instructions file
describing the synced vault and the `--json` commands.

## Migration from pi

- Config stays at `~/.config/atpsync/config.json` with the same shape; existing
  pi users run `atpsync start` with no re-setup. New fields (`remote`, poll
  intervals) are defaulted on load.
- `fs-vault`, `fs-store`, `config`, `setup`, `session`, `resolve-pds` move to
  `packages/cli/src/`; `watcher` becomes `SyncScheduler`; `setup`'s `SetupIO`
  gets a readline implementation. Error messages referencing `/atpsync` become
  `atpsync`.
- Deleted: `pi-extension/`, `@earendil-works/*` dev/peer deps, the `"pi"`
  package key, the `pi-package` keyword, the README pi section (replaced by a
  CLI section).

## Testing

vitest per package.

- Ported: `tests/pi/*` → `packages/cli/test/`.
- Lock: acquire/release, contention, stale by dead pid, stale by mtime,
  heartbeat keeps it fresh, wait timeout → code 4.
- Scheduler (fake timers): per-trigger debounce, single-flight, pending
  coalescing, lock-held defers instead of waiting.
- Subscription: hand-built DAG-CBOR frames verify filtering (other DID,
  non-notesky collection, matching op); a local `ws` server (dev dependency)
  verifies backoff reconnect and the sync-on-connect.
- Daemon lifecycle e2e: spawn the built CLI with a temp config/state dir and an
  unreachable PDS; `start` → pidfile and `daemon.json` appear → `status --json`
  shows running → second `start` refuses → `stop` cleans up; stale pidfile
  handled.
- MCP: SDK `InMemoryTransport`; list tools; call `status` and `publish` against
  `FakePds`.
- Optional live test (env-gated like the existing Docker PDS test): a write
  from a second client triggers a daemon sync within a few seconds.
