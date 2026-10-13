# ATProto Sync — pi extension

Sync an Obsidian-style vault directory to an ATProto PDS **without Obsidian**, using the same
engine, crypto, and record layout (`app.notesky.*`) as the `atproto-sync` Obsidian plugin.

Your notes stay E2E-encrypted at rest: the PDS only ever sees ciphertext (or, for notes you
explicitly publish, plaintext with a public slug).

## How it works

Reuses the plugin's pure core (`src/sync`, `src/crypto`, `src/lexicon`, `src/publish`,
`src/obsidian/pds-client`, `src/obsidian/ignore`) and adds:

- `fs-vault.ts` — a `VaultAdapter` over a plain directory (read/write markdown + binary attachments).
  Detects local renames by file identity (inode + birth time, persisted in
  `<vault>/.atpsync/inodes.json`) so a moved or renamed file/folder keeps its record even when
  it was also edited; removes directories a delete or move left empty
- `fs-store.ts` — the sync index as `<vault>/.atpsync/index.json` (atomic writes)
- `config.ts` — auth + vault binding in `~/.config/atpsync/config.json` (chmod 0600)
- `setup.ts` / `resolve-pds.ts` — app-password login, handle→DID→PDS resolution, vault create/unlock
- `watcher.ts` — `fs.watch` (recursive) + periodic interval, debounced; drops events on ignored
  paths so the engine's own `.atpsync/` writes don't re-trigger a sync
- `index.ts` — pi slash command `/atpsync` + tools for the model

## Install

The extension lives in this repo. It resolves its dependencies from the repo's `node_modules`,
so install first:

```bash
pnpm install        # or: npm install
```

Then load it in pi:

```bash
pi --extension ./pi-extension/index.ts
```

Or make it permanent: copy/symlink `pi-extension/` into `~/.pi/agent/extensions/`.

## Setup (once per machine)

```
/atpsync setup [folder]
```

Setup asks which folder to sync (or takes it as the argument; `~` and relative paths work) and
remembers it in the config. The prompt defaults to the folder bound last time, or the current
directory on first run. A folder that doesn't exist yet is created. Then: enter your handle, app
password, pick or create a vault, and set the encryption passphrase. In headless (non-UI) pi, the
same inputs come from env: `ATPSYNC_HANDLE`, `ATPSYNC_APP_PASSWORD`, `ATPSYNC_VAULT_DIR`,
`ATPSYNC_PASSPHRASE`, plus either `ATPSYNC_VAULT_RKEY` (join an existing vault) or
`ATPSYNC_VAULT_NAME` (create one).

Credentials are written to `~/.config/atpsync/config.json` (mode 0600). On later runs the
passphrase is not re-prompted — the master key is cached locally, exactly like the plugin.

## Everyday use

| Command | What it does |
| --- | --- |
| `/atpsync status` | account, vault, local/remote counts, last sync, watcher state |
| `/atpsync sync` | one bidirectional sync now |
| `/atpsync watch` | toggle background auto-sync (file changes + interval) |
| `/atpsync publish <path> [slug]` | mark a note public (plaintext, slug addressable) + sync |
| `/atpsync unpublish <path>` | re-encrypt a note (key rotates) + sync |
| `/atpsync logout` | clear the app password + cached master key on this device |
| `/atpsync help` | usage |

The model can also drive all of the above through tools: `atpsync_status`, `atpsync_sync`,
`atpsync_publish`, `atpsync_unpublish`, `atpsync_watch`.

## Config

- **Global** (`~/.config/atpsync/config.json`): handle, app password, PDS override, `vaultRkey`,
  cached master key, `vaultDir`, ignore patterns, sync interval.
- **Per vault** (`<vault>/.atpsync/index.json`): the rkey/CID index the engine reconciles against;
  `<vault>/.atpsync/inodes.json`: the path → file identity map rename detection compares against.
  `.atpsync/` is in the default ignore list so it is never synced.

Vault directory for sync/status/publish/watch: the `vaultDir` param (sync tool), else
`ATPSYNC_VAULT_DIR`, else `vaultDir` saved by setup. It never falls back to the working
directory, so running `/atpsync sync` from an unrelated folder fails instead of pulling the
whole vault into it. `/atpsync setup` only uses the working directory to resolve a relative
folder argument and as the first-run prompt default.

## Notes / differences from the plugin

- Auth is **app-password only** (no browser OAuth). Use `/atpsync logout` to revoke locally;
  revoke the app password itself in your PDS settings if needed.
- The watcher lives for the duration of the pi session (it is stopped on session shutdown); it is
  a convenience for interactive coding, not a daemon.
- Oversized attachments (beyond the PDS blob limit) are skipped with a warning, matching the plugin.

## Tests

```bash
npx vitest run tests/pi        # fs adapter, index store, config, setup, full two-device sync
npx tsc --noEmit               # whole-repo typecheck (includes pi-extension)
```
