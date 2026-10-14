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
autostart. If the daemon is already running, `atpsync start` exits 1 with an "already running"
error, so it is safe to call from a login script.

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
