# Monorepo Restructure (Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single-package repo into pnpm workspaces (`core`, `obsidian`, `cli`) with no behavior change to the Obsidian plugin, and retire the pi wrapper by moving its portable modules into `packages/cli`.

**Architecture:** `packages/core` holds the Obsidian-free engine (`sync`, `crypto`, `lexicon`, `publish`, plus `pds-client` and `ignore`) and is consumed as TypeScript source through a `"./*": "./src/*.ts"` exports map (no build step). `packages/obsidian` is the plugin and imports `@atproto-sync/core/...`. `packages/cli` receives the pi extension's plain-Node modules unchanged except for import paths; `pi-extension/index.ts` and every pi dependency are deleted. The plugin build keeps writing `main.js` to the repo root, so `manifest.json`, `versions.json`, `styles.css`, the dev symlink workflow in `docs/manual-testing.md`, and the release workflow's asset paths all stay valid.

**Tech Stack:** pnpm 10 workspaces, TypeScript 7 (`moduleResolution: bundler`), vitest 4, esbuild.

**Spec:** `docs/plans/2026-10-14-atpsync-cli-daemon-design.md` (section "Phase A: monorepo layout").

## Global Constraints

- `manifest.json` and `versions.json` stay at the repo root (Obsidian's updater reads them there).
- Plugin build output `main.js` is written to the repo root; `styles.css` stays at the repo root. (Deviation from the spec's "styles.css moves", made so the dev symlink and release asset paths are untouched; Task 3 updates the spec line.)
- No runtime behavior change to the plugin: same source, same esbuild options.
- Use `git mv` for every move so history follows the files.
- Package names: `@atproto-sync/core`, `@atproto-sync/obsidian`, `@atproto-sync/cli`; all `"private": true`.
- Root scripts `typecheck`, `test`, `build` keep their names (the release workflow calls them).

## Review Focus

1. **Release workflow on a tag** — `pnpm run typecheck`, `pnpm test`, `pnpm run build` from the root must still pass and produce root `main.js`; pinned by Task 3 Step 4 running exactly the workflow's commands.
2. **Dev symlink install** (`ln -s "$(pwd)" …/plugins/notesky-sync`) — repo root must still contain `main.js`, `manifest.json`, `styles.css` after a build; pinned by Task 2 Step 6.
3. **Fresh clone install** — `pnpm install --frozen-lockfile` must succeed with the regenerated lockfile; pinned by Task 3 Step 4.
4. **Live integration tests** (env-gated) must still be discovered after their move, not silently dropped; pinned by Task 1 Step 7 (test count check).
5. **Existing pi users' config** at `~/.config/atpsync/config.json` is untouched by the move (the `config.ts` module moves verbatim); pinned by the ported config tests in Task 2.

---

## File Structure (end state)

```
package.json                 # root: private, workspace scripts, shared devDeps
pnpm-workspace.yaml
tsconfig.base.json           # shared compilerOptions (old tsconfig.json body)
tsconfig.json                # removed (replaced by per-package configs)
manifest.json versions.json styles.css main.js(build output)   # unchanged location
packages/
  core/
    package.json  tsconfig.json
    lexicons/app/notesky/*.json
    src/{sync,crypto,lexicon,publish}/...      # moved from src/
    src/atproto/pds-client.ts                  # from src/obsidian/pds-client.ts
    src/sync/ignore.ts                         # from src/obsidian/ignore.ts
    test/{sync,crypto,lexicon,publish}/...     # moved from tests/
    test/atproto/pds-client.integration.test.ts
    test/sync/ignore.test.ts
    test/smoke.test.ts
  obsidian/
    package.json  tsconfig.json  esbuild.config.mjs
    src/*.ts                                   # from src/obsidian/*.ts (minus the two moved)
    test/store.test.ts
  cli/
    package.json  tsconfig.json
    src/{config,fs-store,fs-vault,resolve-pds,session,setup,watcher}.ts   # from pi-extension/
    test/{cli.test.ts,fixes.test.ts}           # from tests/pi/
```

---

### Task 1: Workspace scaffolding and `packages/core`

**Files:**
- Create: `pnpm-workspace.yaml`, `tsconfig.base.json`, `packages/core/package.json`, `packages/core/tsconfig.json`
- Move: `src/{sync,crypto,lexicon,publish}` → `packages/core/src/`, `lexicons/` → `packages/core/lexicons/`, `src/obsidian/pds-client.ts` → `packages/core/src/atproto/pds-client.ts`, `src/obsidian/ignore.ts` → `packages/core/src/sync/ignore.ts`, `tests/{sync,crypto,lexicon,publish}` → `packages/core/test/`, `tests/obsidian/ignore.test.ts` → `packages/core/test/sync/ignore.test.ts`, `tests/obsidian/pds-client.integration.test.ts` → `packages/core/test/atproto/`, `tests/smoke.test.ts` → `packages/core/test/`
- Modify: `package.json`

**Interfaces:**
- Produces: importable specifiers `@atproto-sync/core/<dir>/<file>` (e.g. `@atproto-sync/core/sync/engine`, `@atproto-sync/core/atproto/pds-client`, `@atproto-sync/core/sync/ignore`) for Tasks 2+.

- [ ] **Step 1: Record the baseline test count**

Run: `pnpm test 2>&1 | tail -5`
Expected: all pass; note the `Tests  N passed | M skipped` line. Tasks 1–2 together must end with the same N + M.

- [ ] **Step 2: Create workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
```

`tsconfig.base.json` (body of the old `tsconfig.json`, minus `include`):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "isolatedModules": true,
    "noEmit": true
  }
}
```

`packages/core/package.json`:
```json
{
  "name": "@atproto-sync/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    "./*": "./src/*.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p ."
  },
  "dependencies": {
    "@atproto/api": "^0.20.41",
    "diff-match-patch": "^1.0.5",
    "libsodium-wrappers-sumo": "^0.8.4"
  },
  "devDependencies": {
    "@types/diff-match-patch": "^1.0.36",
    "@types/libsodium-wrappers-sumo": "^0.7.8"
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Move core sources and tests**

```bash
mkdir -p packages/core/src/atproto packages/core/test/atproto
git mv src/sync src/crypto src/lexicon src/publish packages/core/src/
git mv lexicons packages/core/lexicons
git mv src/obsidian/pds-client.ts packages/core/src/atproto/pds-client.ts
git mv src/obsidian/ignore.ts packages/core/src/sync/ignore.ts
git mv tests/sync tests/crypto tests/lexicon tests/publish packages/core/test/
git mv tests/obsidian/ignore.test.ts packages/core/test/sync/ignore.test.ts
git mv tests/obsidian/pds-client.integration.test.ts packages/core/test/atproto/pds-client.integration.test.ts
git mv tests/smoke.test.ts packages/core/test/smoke.test.ts
```

Core tests at `packages/core/test/<dir>/x.test.ts` import `../../src/<dir>/...`, which still resolves. Only the moved-file references change.

- [ ] **Step 4: Fix imports that referenced the two moved files**

`packages/core/src/atproto/pds-client.ts`: `'../sync/pds'` is still correct (no change).

In these files replace the `src/obsidian/...` specifiers:
- `packages/core/test/sync/ignore.test.ts`: `'../../src/obsidian/ignore'` → `'../../src/sync/ignore'`
- `packages/core/test/atproto/pds-client.integration.test.ts`: `'../../src/obsidian/pds-client'` → `'../../src/atproto/pds-client'` (the `'../../src/sync/pds'` import stays)
- `packages/core/test/sync/engine-live.integration.test.ts`: `'../../src/obsidian/pds-client'` → `'../../src/atproto/pds-client'`

Verify nothing else in core references `obsidian`:
Run: `grep -rn "obsidian" packages/core/src packages/core/test`
Expected: no import hits (comments are fine).

- [ ] **Step 5: Root `package.json` becomes the workspace root**

Replace the whole file with:
```json
{
  "name": "atproto-sync",
  "version": "0.1.0",
  "private": true,
  "description": "Sync your Obsidian vault to your ATProto PDS, E2E-encrypted, with per-note publishing.",
  "license": "ISC",
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "build": "pnpm --filter @atproto-sync/obsidian build",
    "dev": "pnpm --filter @atproto-sync/obsidian dev"
  },
  "devDependencies": {
    "@types/node": "^26.2.0",
    "esbuild": "^0.28.2",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
```
(The pi devDeps, `peerDependencies`, the `"pi"` key, `keywords` and `main` are dropped here; pi's code is handled in Task 2.)

- [ ] **Step 6: Install and run core alone**

Run: `pnpm install && pnpm --filter @atproto-sync/core typecheck && pnpm --filter @atproto-sync/core test`
Expected: typecheck clean; all core tests pass (integration tests skipped without env).

- [ ] **Step 7: Check the live tests are still discovered**

Run: `pnpm --filter @atproto-sync/core exec vitest list 2>/dev/null | grep -c integration`
Expected: ≥ 1 (the `.integration.test.ts` suites are listed even though they skip).

- [ ] **Step 8: Commit** (the obsidian/cli packages are fixed in Task 2; do not push between Tasks 1 and 2)

```bash
git add -A
git commit -m "refactor: extract @atproto-sync/core workspace package"
```

---

### Task 2: `packages/obsidian` and `packages/cli`, delete pi wrapper

**Files:**
- Create: `packages/obsidian/package.json`, `packages/obsidian/tsconfig.json`, `packages/cli/package.json`, `packages/cli/tsconfig.json`
- Move: `src/obsidian/*` → `packages/obsidian/src/`, `esbuild.config.mjs` → `packages/obsidian/esbuild.config.mjs`, `tests/obsidian/store.test.ts` → `packages/obsidian/test/store.test.ts`, `pi-extension/{config,fs-store,fs-vault,resolve-pds,session,setup,watcher}.ts` → `packages/cli/src/`, `tests/pi/pi-extension.test.ts` → `packages/cli/test/cli.test.ts`, `tests/pi/fixes.test.ts` → `packages/cli/test/fixes.test.ts`
- Delete: `pi-extension/index.ts`, `pi-extension/README.md`, `tsconfig.json`, empty `src/`, `tests/`, `pi-extension/`

**Interfaces:**
- Consumes: `@atproto-sync/core/*` from Task 1.
- Produces: `packages/cli/src/*.ts` with the same exports as the old `pi-extension/*.ts` (Phase B builds on these: `loadConfig`, `saveConfig`, `isConfigured`, `boundVaultDir`, `expandVaultPath`, `ensureVaultDir`, `configPath`, `DEFAULT_CONFIG`, `DEFAULT_IGNORES`, `AtpsyncConfig`; `FsVaultAdapter`, `isMarkdownPath`, `resolveInsideVault`; `FsIndexStore`; `resolvePdsUrl`; `runSync`, `togglePublic`, `getVaultStatus`, `formatSummary`, `makePdsClient`, `clearPdsCache`, `SyncSummary`, `VaultStatus`; `runSetup`, `createVault`, `unlockVault`, `listVaults`, `WrongPassphraseError`, `SetupIO`, `SetupDeps`; `VaultWatcher`).

- [ ] **Step 1: Move files**

```bash
mkdir -p packages/obsidian/test packages/cli/src packages/cli/test
git mv src/obsidian packages/obsidian/src
git mv esbuild.config.mjs packages/obsidian/esbuild.config.mjs
git mv tests/obsidian/store.test.ts packages/obsidian/test/store.test.ts
for f in config fs-store fs-vault resolve-pds session setup watcher; do git mv pi-extension/$f.ts packages/cli/src/$f.ts; done
git mv tests/pi/pi-extension.test.ts packages/cli/test/cli.test.ts
git mv tests/pi/fixes.test.ts packages/cli/test/fixes.test.ts
git rm -q pi-extension/index.ts pi-extension/README.md tsconfig.json
```
Run: `ls src tests pi-extension 2>&1`
Expected: all three report "No such file or directory" (git removes emptied dirs; `rmdir` any that remain).

- [ ] **Step 2: Package manifests**

`packages/obsidian/package.json`:
```json
{
  "name": "@atproto-sync/obsidian",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node esbuild.config.mjs production",
    "dev": "node esbuild.config.mjs",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p ."
  },
  "dependencies": {
    "@atproto-sync/core": "workspace:*",
    "@atproto/api": "^0.20.41",
    "@atproto/oauth-client": "^0.8.3",
    "@atproto/oauth-client-browser": "^0.5.3"
  },
  "devDependencies": {
    "fake-indexeddb": "^6.2.5",
    "obsidian": "^1.13.1",
    "tslib": "^2.8.1"
  }
}
```

`packages/cli/package.json`:
```json
{
  "name": "@atproto-sync/cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p ."
  },
  "dependencies": {
    "@atproto-sync/core": "workspace:*"
  }
}
```

`packages/obsidian/tsconfig.json` and `packages/cli/tsconfig.json` (identical):
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Rewrite obsidian imports**

In `packages/obsidian/src/*.ts`, rewrite every relative import that leaves the folder:
- `'../crypto/X'` → `'@atproto-sync/core/crypto/X'`
- `'../sync/X'` → `'@atproto-sync/core/sync/X'`
- `'../lexicon/X'` → `'@atproto-sync/core/lexicon/X'`
- `'../publish/X'` → `'@atproto-sync/core/publish/X'`
- `'./pds-client'` → `'@atproto-sync/core/atproto/pds-client'`
- `'./ignore'` → `'@atproto-sync/core/sync/ignore'`

```bash
cd packages/obsidian/src
sed -i -E "s#from '\.\./(crypto|sync|lexicon|publish)/#from '@atproto-sync/core/\1/#; s#from '\./pds-client'#from '@atproto-sync/core/atproto/pds-client'#; s#from '\./ignore'#from '@atproto-sync/core/sync/ignore'#" *.ts
cd -
```
`packages/obsidian/test/store.test.ts`: `'../../src/obsidian/store'` → `'../src/store'`.

Run: `grep -rn "from '\.\./" packages/obsidian/src`
Expected: no output.

- [ ] **Step 4: Rewrite cli imports**

In `packages/cli/src/*.ts`:
- `'../src/crypto/X'` → `'@atproto-sync/core/crypto/X'` (same for `sync`, `lexicon`, `publish`)
- `'../src/obsidian/pds-client'` → `'@atproto-sync/core/atproto/pds-client'`
- `'../src/obsidian/ignore'` → `'@atproto-sync/core/sync/ignore'`

In `packages/cli/test/*.ts`:
- `'../../src/<dir>/X'` → `'@atproto-sync/core/<dir>/X'` for `crypto|sync|lexicon|publish`
- `'../../src/obsidian/ignore'` → `'@atproto-sync/core/sync/ignore'`
- `'../../pi-extension/X'` → `'../src/X'`

```bash
sed -i -E "s#from '\.\./src/(crypto|sync|lexicon|publish)/#from '@atproto-sync/core/\1/#; s#from '\.\./src/obsidian/pds-client'#from '@atproto-sync/core/atproto/pds-client'#; s#from '\.\./src/obsidian/ignore'#from '@atproto-sync/core/sync/ignore'#" packages/cli/src/*.ts
sed -i -E "s#from '\.\./\.\./src/(crypto|sync|lexicon|publish)/#from '@atproto-sync/core/\1/#; s#from '\.\./\.\./src/obsidian/ignore'#from '@atproto-sync/core/sync/ignore'#; s#from '\.\./\.\./pi-extension/#from '../src/#" packages/cli/test/*.ts
```
Run: `grep -rn "pi-extension\|src/obsidian\|from '\.\./\.\./" packages/cli`
Expected: no import hits.

- [ ] **Step 5: Point the plugin build at the new layout**

In `packages/obsidian/esbuild.config.mjs` change exactly two options:
```js
  entryPoints: ['src/main.ts'],
  ...
  outfile: '../../main.js',
```
(Everything else in the file is unchanged.)

- [ ] **Step 6: Install, typecheck, test, build**

Run: `pnpm install && pnpm run typecheck && pnpm test && rm -f main.js && pnpm run build && ls main.js manifest.json styles.css`
Expected: typecheck clean; test totals equal the Step 1 baseline of Task 1 (N passed, M skipped) summed across packages; `main.js`, `manifest.json`, `styles.css` all listed at the repo root.

- [ ] **Step 7: Confirm the bundle is functionally unchanged**

Build the pre-restructure commit (the parent of Task 1's commit) in a throwaway worktree and compare sizes:
```bash
BASE=$(git log --format=%H -1 --grep='extract @atproto-sync/core')~1
git worktree add -q ../atps-base "$BASE"
(cd ../atps-base && pnpm install -s && pnpm run build -s)
ls -l ../atps-base/main.js main.js
git worktree remove --force ../atps-base
```
Expected: byte sizes within a few hundred bytes (only module path comments differ). A large difference means a dependency or option changed — investigate before committing.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: move plugin and pi modules into obsidian/cli workspace packages, drop pi wrapper"
```

---

### Task 3: CI, docs, cleanup

**Files:**
- Modify: `.github/workflows/release.yml`, `README.md`, `docs/manual-testing.md`, `.gitignore`, `docs/plans/2026-10-14-atpsync-cli-daemon-design.md`

- [ ] **Step 1: Release workflow**

The workflow's commands (`pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm test`, `pnpm run build`) and asset paths (`main.js manifest.json styles.css` at root) still hold. Only bump the pnpm action so it matches the lockfile written by pnpm 10:
```yaml
      - uses: pnpm/action-setup@v4
        with:
          version: 10
```

- [ ] **Step 2: README**

- In "Development", replace the block with:
```bash
pnpm install
pnpm test          # all packages (core, obsidian, cli)
pnpm run build     # produces main.js at the repo root
```
and replace the following paragraph with: "The repo is a pnpm workspace: `packages/core` (sync engine, crypto, reconciler — no Obsidian dependency, fully unit-tested), `packages/obsidian` (the plugin), and `packages/cli` (the `atpsync` command-line tool). See `docs/` for the design documents and the manual testing guide (including a local Docker PDS setup)."
- Delete the "## pi extension (sync without Obsidian)" section entirely (Phase B adds a CLI section).

- [ ] **Step 3: Manual testing guide, gitignore, spec**

- `docs/manual-testing.md`: wherever it says `src/…` paths, prefix with `packages/obsidian/` or `packages/core/` as appropriate (`grep -n "src/\|tests/" docs/manual-testing.md` to find them). The `pnpm run build` and `ln -s "$(pwd)"` lines stay as they are.
- `.gitignore`: add `packages/*/dist/`.
- Spec, "Phase A: monorepo layout" bullet for `packages/obsidian`: replace "its esbuild config, `styles.css`." with "its esbuild config. `styles.css` stays at the repo root and the build writes `main.js` to the repo root, so the plugin dev symlink and release asset paths are unchanged." Replace the release-workflow bullet with: "The release workflow is unchanged apart from the pnpm version." Add a final bullet to that section: "Phase A also moves the pi extension's plain-Node modules into `packages/cli/src/` and deletes `pi-extension/index.ts` and the pi dependencies; Phase B builds the CLI on those modules."

- [ ] **Step 4: Run the workflow's exact commands from a clean tree**

```bash
rm -rf node_modules packages/*/node_modules main.js
pnpm install --frozen-lockfile && pnpm run typecheck && pnpm test && pnpm run build && ls main.js
```
Expected: every command exits 0; `main.js` listed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: update CI, docs and gitignore for the workspace layout"
```
