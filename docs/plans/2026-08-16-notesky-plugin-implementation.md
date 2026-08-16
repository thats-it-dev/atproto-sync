# Notesky Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the Notesky Obsidian plugin: vault sync to/from an ATProto PDS with per-note E2E encryption and a public-note toggle, per `docs/plans/2026-08-16-notesky-sync-design.md`.

**Architecture:** The plugin is the whole system — no server. A pure sync reconciler (testable against an in-memory fake PDS) sits at the core; crypto and lexicon modules feed it; Obsidian-specific glue (vault events, UI, auth) wraps it. TDD everything below the Obsidian glue line; the glue gets manual verification steps in a dev vault.

**Tech Stack:** TypeScript, esbuild, vitest, `libsodium-wrappers-sumo` (Argon2id + XChaCha20-Poly1305), `node-diff3` (three-way merge), `@atproto/api` (PDS client), `fake-indexeddb` (store tests), Obsidian plugin API.

**Working directory:** `.worktrees/vault-sync` (branch `feature/vault-sync`).

**Conventions for every task:** run tests with `npx vitest run <file>`; commit after each green test with the message given in the task. Source in `src/`, tests in `tests/` mirroring `src/` paths. Never use the DOM/Obsidian API below `src/obsidian/` — everything else must run in plain Node so vitest can test it.

---

## Phase 1: Scaffolding

### Task 1: npm project + TypeScript + vitest

**Files:**
- Create: `package.json`, `tsconfig.json`, `tests/smoke.test.ts`

**Step 1:** Initialize:

```bash
npm init -y
npm i -D typescript vitest esbuild @types/node obsidian tslib
npm i libsodium-wrappers-sumo node-diff3 @atproto/api
npm i -D @types/libsodium-wrappers-sumo fake-indexeddb
```

**Step 2:** `tsconfig.json`:

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
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

Add to `package.json` scripts: `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`.

**Step 3:** Write `tests/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('toolchain', () => {
  it('runs tests', () => {
    expect(1 + 1).toBe(2);
  });
});
```

**Step 4:** Run `npx vitest run` → expect 1 passing. Run `npx tsc --noEmit` → clean.

**Step 5:** Add `node_modules/` and `main.js` to `.gitignore` (repo root `.gitignore` already has `.worktrees/`; create a project-level one in the worktree covering build outputs).

**Step 6:** Commit: `chore: scaffold TypeScript project with vitest`

### Task 2: Obsidian plugin skeleton + esbuild

**Files:**
- Create: `manifest.json`, `src/obsidian/main.ts`, `esbuild.config.mjs`, `versions.json`

**Step 1:** `manifest.json`:

```json
{
  "id": "notesky-sync",
  "name": "Notesky Sync",
  "version": "0.1.0",
  "minAppVersion": "1.5.0",
  "description": "Sync your vault to your ATProto PDS (Bluesky, Blacksky, Eurosky, self-hosted). E2E-encrypted, with per-note publishing.",
  "author": "Michael Gutensohn",
  "isDesktopOnly": false
}
```

**Step 2:** `src/obsidian/main.ts` (stub that loads):

```ts
import { Plugin } from 'obsidian';

export default class NoteskyPlugin extends Plugin {
  async onload() {
    console.log('Notesky Sync loaded');
  }
}
```

**Step 3:** `esbuild.config.mjs` — standard Obsidian sample-plugin config: entry `src/obsidian/main.ts`, bundle, external `["obsidian", "electron"]`, format `cjs`, outfile `main.js`, target `es2022`. Add scripts `"build": "node esbuild.config.mjs production"` and `"dev": "node esbuild.config.mjs"`. Copy the config from the official obsidian-sample-plugin (it handles watch/production modes); don't reinvent it.

**Step 4:** Run `npm run build` → `main.js` exists at repo root of the worktree.

**Step 5:** Manual check (do once, at your leisure — not blocking): symlink the worktree into a throwaway dev vault's `.obsidian/plugins/notesky-sync/`, enable the plugin, confirm the console log appears.

**Step 6:** Commit: `feat: Obsidian plugin skeleton with esbuild`

---

## Phase 2: Lexicon

### Task 3: Lexicon JSON schemas

**Files:**
- Create: `lexicons/app/notesky/note.json`, `attachment.json`, `folder.json`, `vault.json`, `tombstone.json`

These are the published contract; review hardest. `note.json`:

```json
{
  "lexicon": 1,
  "id": "app.notesky.note",
  "defs": {
    "main": {
      "type": "record",
      "description": "A markdown note in a Notesky-synced vault.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["vault", "formatVersion", "updatedAt", "contentHash", "content"],
        "properties": {
          "vault": { "type": "string", "description": "rkey of the app.notesky.vault record this note belongs to" },
          "formatVersion": { "type": "integer", "minimum": 1 },
          "createdAt": { "type": "string", "format": "datetime" },
          "updatedAt": { "type": "string", "format": "datetime" },
          "contentHash": { "type": "string", "description": "sha256 hex of the stored content bytes (ciphertext when encrypted) for transport integrity" },
          "content": {
            "type": "union",
            "refs": ["#encrypted", "#plaintext"]
          }
        }
      }
    },
    "encrypted": {
      "type": "object",
      "required": ["keyId", "wrappedKey", "keyNonce", "contentNonce", "ciphertext"],
      "properties": {
        "keyId": { "type": "string" },
        "wrappedKey": { "type": "string", "description": "base64: per-note key wrapped by master key" },
        "keyNonce": { "type": "string" },
        "contentNonce": { "type": "string" },
        "ciphertext": { "type": "string", "description": "base64: XChaCha20-Poly1305 over JSON {path, title, body}" }
      }
    },
    "plaintext": {
      "type": "object",
      "required": ["path", "title", "slug", "text", "createdAt", "updatedAt"],
      "properties": {
        "path": { "type": "string" },
        "title": { "type": "string" },
        "slug": { "type": "string" },
        "description": { "type": "string" },
        "tags": { "type": "array", "items": { "type": "string" } },
        "coverImage": { "type": "ref", "ref": "com.atproto.repo.strongRef" },
        "text": { "type": "string" },
        "createdAt": { "type": "string", "format": "datetime" },
        "updatedAt": { "type": "string", "format": "datetime" }
      }
    }
  }
}
```

`vault.json` record: `{ name, formatVersion, kdf: { alg: "argon2id13", saltB64, opsLimit, memLimit }, checkValue: { nonce, ciphertext }, createdAt }`.
`tombstone.json` record: `{ vault, target: string (rkey of deleted record), collection, deletedAt }`.
`attachment.json`: like note but content union references a `blob` plus encrypted/plaintext metadata objects.
`folder.json`: metadata union only (encrypted `{path}` or plaintext `{path}`).

**Step: no test for JSON files** — they're validated by usage in Task 4. Commit: `feat: app.notesky.* lexicon schemas`

### Task 4: TypeScript record types + builders

**Files:**
- Create: `src/lexicon/types.ts`, `src/lexicon/build.ts`
- Test: `tests/lexicon/build.test.ts`

**Step 1:** Failing test:

```ts
import { describe, it, expect } from 'vitest';
import { buildPlaintextNote, isEncrypted, NOTE_COLLECTION } from '../../src/lexicon/build';

describe('lexicon builders', () => {
  it('builds a plaintext note record with slug derived from title', () => {
    const rec = buildPlaintextNote({
      vault: 'vault123', path: 'Ideas/My Great Note.md',
      text: '# hi', createdAt: '2026-08-16T00:00:00Z', updatedAt: '2026-08-16T00:00:00Z',
    });
    expect(rec.$type).toBe('app.notesky.note');
    expect(NOTE_COLLECTION).toBe('app.notesky.note');
    if (isEncrypted(rec.content)) throw new Error('expected plaintext');
    expect(rec.content.title).toBe('My Great Note');
    expect(rec.content.slug).toBe('my-great-note');
    expect(rec.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

**Step 2:** Run → FAIL (module not found).

**Step 3:** Implement `types.ts` (interfaces `NoteRecord`, `EncryptedContent`, `PlaintextContent`, `VaultRecord`, `TombstoneRecord`, `AttachmentRecord`, `FolderRecord` mirroring the JSON schemas exactly) and `build.ts` (`buildPlaintextNote`, `buildEncryptedNote`, `slugify` — lowercase, NFC-normalize, strip non-alphanumerics to hyphens, collapse repeats — `isEncrypted` type guard, collection-name constants, `sha256Hex` via Node/WebCrypto `crypto.subtle`; make it async or precompute — keep the API async: `buildPlaintextNote` returns `Promise<NoteRecord>`; adjust the test with `await`).

**Step 4:** Run → PASS. **Step 5:** Commit: `feat: lexicon record types and builders`

---

## Phase 3: Crypto module

### Task 5: Master key derivation (Argon2id)

**Files:**
- Create: `src/crypto/keys.ts`
- Test: `tests/crypto/keys.test.ts`

**Step 1:** Failing test:

```ts
import { describe, it, expect } from 'vitest';
import { deriveMasterKey, generateSalt, DEFAULT_KDF_PARAMS } from '../../src/crypto/keys';

describe('deriveMasterKey', () => {
  it('is deterministic for same passphrase+salt and differs across salts', async () => {
    const salt = await generateSalt();
    const a = await deriveMasterKey('correct horse', salt, DEFAULT_KDF_PARAMS);
    const b = await deriveMasterKey('correct horse', salt, DEFAULT_KDF_PARAMS);
    const c = await deriveMasterKey('correct horse', await generateSalt(), DEFAULT_KDF_PARAMS);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.length).toBe(32);
  });
});
```

**Step 2:** Run → FAIL.

**Step 3:** Implement with `libsodium-wrappers-sumo` (the sumo build is required — `crypto_pwhash` is absent from the standard build):

```ts
import sodium from 'libsodium-wrappers-sumo';

export interface KdfParams { opsLimit: number; memLimit: number }
// Tuned down from INTERACTIVE for mobile; revisit in Task 22 perf pass.
export const DEFAULT_KDF_PARAMS: KdfParams = { opsLimit: 2, memLimit: 32 * 1024 * 1024 };

export async function generateSalt(): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
}

export async function deriveMasterKey(passphrase: string, salt: Uint8Array, p: KdfParams): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_pwhash(32, passphrase.normalize('NFC'), salt, p.opsLimit, p.memLimit, sodium.crypto_pwhash_ALG_ARGON2ID13);
}
```

**Step 4:** Run → PASS. **Step 5:** Commit: `feat: Argon2id master key derivation`

### Task 6: Wrap/unwrap per-note keys, encrypt/decrypt content

**Files:**
- Create: `src/crypto/box.ts`
- Test: `tests/crypto/box.test.ts`

**Step 1:** Failing tests:

```ts
import { describe, it, expect } from 'vitest';
import { generateNoteKey, wrapKey, unwrapKey, encrypt, decrypt } from '../../src/crypto/box';

describe('note key lifecycle', () => {
  it('round-trips: wrap key, unwrap key, encrypt content, decrypt content', async () => {
    const master = new Uint8Array(32).fill(7);
    const noteKey = await generateNoteKey();
    const wrapped = await wrapKey(noteKey, master);
    expect(await unwrapKey(wrapped, master)).toEqual(noteKey);
    const box = await encrypt(new TextEncoder().encode('secret note'), noteKey);
    expect(new TextDecoder().decode(await decrypt(box, noteKey))).toBe('secret note');
  });
  it('fails loudly on wrong key and on tampered ciphertext', async () => {
    const noteKey = await generateNoteKey();
    const box = await encrypt(new TextEncoder().encode('x'), noteKey);
    await expect(decrypt(box, await generateNoteKey())).rejects.toThrow();
    box.ciphertext[0] ^= 0xff;
    await expect(decrypt(box, noteKey)).rejects.toThrow();
  });
});
```

**Step 2:** Run → FAIL.

**Step 3:** Implement: `Box = { nonce: Uint8Array, ciphertext: Uint8Array }`. `encrypt` = fresh 24-byte nonce + `crypto_aead_xchacha20poly1305_ietf_encrypt(msg, null, null, nonce, key)`; `decrypt` correspondingly; `wrapKey`/`unwrapKey` are `encrypt`/`decrypt` of the raw key bytes. Also export `toB64`/`fromB64` (sodium `to_base64`/`from_base64`, `URLSAFE_NO_PADDING`).

**Step 4:** Run → PASS. **Step 5:** Commit: `feat: XChaCha20-Poly1305 wrap and content encryption`

### Task 7: Passphrase check value

**Files:**
- Create: `src/crypto/check.ts`
- Test: `tests/crypto/check.test.ts`

**Step 1:** Test: `makeCheckValue(master)` returns a Box; `verifyCheckValue(box, master)` → true; with a key derived from a different passphrase → false (not throw).

**Step 2–4:** Implement as encrypt/decrypt of the fixed string `"notesky-check-v1"`; `verifyCheckValue` catches decryption failure and returns false. Run → PASS.

**Step 5:** Commit: `feat: passphrase check value for fail-fast verification`

### Task 8: Note-level encrypt/decrypt (metadata inside payload)

**Files:**
- Create: `src/crypto/note.ts`
- Test: `tests/crypto/note.test.ts`

**Step 1:** Failing test:

```ts
import { describe, it, expect } from 'vitest';
import { encryptNote, decryptNote } from '../../src/crypto/note';

it('hides path and title inside the ciphertext and round-trips', async () => {
  const master = new Uint8Array(32).fill(9);
  const enc = await encryptNote({ path: 'Private/Journal.md', title: 'Journal', body: 'dear diary' }, master);
  const json = JSON.stringify(enc);
  expect(json).not.toContain('Journal');
  expect(json).not.toContain('dear diary');
  const dec = await decryptNote(enc, master);
  expect(dec).toEqual({ path: 'Private/Journal.md', title: 'Journal', body: 'dear diary' });
});
```

**Step 2:** Run → FAIL.

**Step 3:** Implement: `encryptNote` generates a note key, encrypts `JSON.stringify({path, title, body})`, wraps the key, returns an `EncryptedContent` (lexicon shape: b64 strings, fresh `keyId` via `sodium.randombytes_buf(8)` hex). `decryptNote` reverses. Path is NFC-normalized on the way in.

**Step 4:** Run → PASS. **Step 5:** Commit: `feat: note-level encryption with private metadata`

---

## Phase 4: Sync core

### Task 9: Fake PDS with CAS semantics

**Files:**
- Create: `src/sync/pds.ts` (interface), `src/sync/fake-pds.ts`
- Test: `tests/sync/fake-pds.test.ts`

**Step 1:** Failing tests — the interface both fake and real client implement:

```ts
// pds.ts shape:
// interface PdsClient {
//   putRecord(collection: string, rkey: string, value: unknown, swapCid?: string | null): Promise<{ cid: string }>
//     // swapCid === null means "must not exist" (create); undefined means unconditional
//   getRecord(collection: string, rkey: string): Promise<{ cid: string; value: unknown } | null>
//   listRecords(collection: string): Promise<Array<{ rkey: string; cid: string; value: unknown }>>
//   deleteRecord(collection: string, rkey: string, swapCid?: string): Promise<void>
// }
// class CasError extends Error {}
```

Tests: put+get round-trip; list returns all; CAS success (put with current cid), CAS failure throws `CasError` (put with stale cid; put-with-null when record exists); delete with stale cid throws; cid changes on every put.

**Step 2:** Run → FAIL.

**Step 3:** Implement `FakePds` with a `Map<string, Map<string, {cid, value}>>`; cid = incrementing counter stringified (`"cid-1"`, `"cid-2"`) — fake cids don't need to be real CIDs, only unique.

**Step 4:** Run → PASS. **Step 5:** Commit: `feat: fake PDS with compare-and-swap semantics`

### Task 10: Three-way merge

**Files:**
- Create: `src/sync/merge.ts`
- Test: `tests/sync/merge.test.ts`

**Step 1:** Failing tests:

```ts
import { describe, it, expect } from 'vitest';
import { merge3 } from '../../src/sync/merge';

describe('merge3', () => {
  it('merges non-overlapping edits cleanly', () => {
    const base = 'line1\nline2\nline3\n';
    const local = 'line1 edited\nline2\nline3\n';
    const remote = 'line1\nline2\nline3 edited\n';
    const r = merge3(base, local, remote);
    expect(r.clean).toBe(true);
    expect(r.merged).toBe('line1 edited\nline2\nline3 edited\n');
  });
  it('flags overlapping edits as conflict and includes both sides', () => {
    const r = merge3('a\n', 'local a\n', 'remote a\n');
    expect(r.clean).toBe(false);
    expect(r.merged).toContain('local a');
    expect(r.merged).toContain('remote a');
  });
});
```

**Step 2:** Run → FAIL.

**Step 3:** Implement with `node-diff3`'s `merge(local, base, remote)` (note the argument order: a, o, b) splitting on lines; on conflict, `clean: false` and `merged` joins the conflict-marker output. Check the library's actual exported API when implementing; if its conflict markers are unsuitable, build output from `diff3Merge` chunks directly.

**Step 4:** Run → PASS. **Step 5:** Commit: `feat: three-way markdown merge`

### Task 11: Reconciler types + no-op/push/pull

**Files:**
- Create: `src/sync/reconcile.ts`
- Test: `tests/sync/reconcile.test.ts`

The reconciler is a **pure function** — no I/O, no crypto, no Obsidian. It sees decrypted logical state:

```ts
export interface LocalFile { path: string; content: string }
export interface RemoteNote { rkey: string; cid: string; path: string; content: string; deleted?: boolean }
export interface IndexEntry { path: string; rkey: string; baseContent: string; lastCid: string }
export type Op =
  | { kind: 'push'; path: string; rkey: string; content: string; swapCid: string }
  | { kind: 'pushCreate'; path: string; content: string }
  | { kind: 'pull'; path: string; rkey: string; content: string; cid: string }
  | { kind: 'pullCreate'; path: string; rkey: string; content: string; cid: string }
  | { kind: 'merge'; path: string; rkey: string; base: string; local: string; remote: string; swapCid: string }
  | { kind: 'deleteRemote'; rkey: string; path: string; swapCid: string }
  | { kind: 'deleteLocal'; path: string; rkey: string }
export function reconcile(local: LocalFile[], remote: RemoteNote[], index: IndexEntry[]): Op[]
```

**Step 1:** Failing tests: (a) identical everywhere → `[]`; (b) local content ≠ base, remote cid unchanged → one `push` with `swapCid` = last cid; (c) local == base, remote cid ≠ lastCid → one `pull`.

**Step 2:** Run → FAIL.

**Step 3:** Implement the decision table by joining the three collections on rkey (index is the pivot; path lookups map through index).

**Step 4:** Run → PASS. **Step 5:** Commit: `feat: sync reconciler core (no-op, push, pull)`

### Task 12: Reconciler creates

**Step 1:** Failing tests: local file with no index entry and no remote record at that path → `pushCreate`; remote record with no index entry and no local file → `pullCreate`; **same-path simultaneous create** (local file + unindexed remote record with equal path) → `merge` with empty base.

**Steps 2–4:** Implement; run → PASS.

**Step 5:** Commit: `feat: reconciler handles creates on both sides`

### Task 13: Reconciler both-changed → merge

**Step 1:** Failing test: local ≠ base AND remote cid ≠ lastCid → single `merge` op carrying base/local/remote and `swapCid` = **current remote cid** (the merge result must CAS against what we merged with).

**Steps 2–4:** Implement; run → PASS. **Step 5:** Commit: `feat: reconciler emits merge for concurrent edits`

### Task 14: Deletes, tombstones, edit-wins

**Step 1:** Failing tests:
- Local file missing, index present, remote unchanged → `deleteRemote`.
- Remote record `deleted: true` (tombstoned), local == base → `deleteLocal`.
- Remote tombstoned but local ≠ base → `push` (edit wins, note resurrects).
- Local file missing but remote changed → `pull` (edit wins over local delete).

**Steps 2–4:** Implement; run → PASS. **Step 5:** Commit: `feat: delete propagation with edit-wins semantics`

### Task 15: SyncEngine — executing ops against a PDS

**Files:**
- Create: `src/sync/engine.ts`
- Test: `tests/sync/engine.test.ts`

`SyncEngine` glues reconciler + crypto + PdsClient + a `VaultAdapter` interface (`readAll(): Promise<LocalFile[]>`, `write(path, content)`, `remove(path)`) + an `IndexStore` interface (`load(): Promise<IndexEntry[]>`, `save(entries)`). Fake vault = in-memory map; fake index = in-memory array.

**Step 1:** Failing test — full loop against `FakePds` with encryption on:

```ts
it('syncs an edit from device A to device B, encrypted at rest', async () => {
  const pds = new FakePds();
  const master = new Uint8Array(32).fill(3);
  const a = makeEngine(pds, master);         // helper: engine + in-memory vault/index
  const b = makeEngine(pds, master);
  await a.vault.write('note.md', 'hello');
  await a.engine.sync();
  // At rest on the PDS: no plaintext visible
  const raw = JSON.stringify(await pds.listRecords('app.notesky.note'));
  expect(raw).not.toContain('hello');
  expect(raw).not.toContain('note.md');
  await b.engine.sync();
  expect(await b.vault.read('note.md')).toBe('hello');
});
```

**Step 2:** Run → FAIL.

**Step 3:** Implement `SyncEngine.sync()`: load index → read vault → `listRecords` → decrypt remotes (tombstone records surface as `deleted: true`) → `reconcile` → execute ops in order (encrypt on push; `merge3` for merge ops, clean result pushed / conflict handled per a `conflictMode` option defaulting to `'auto'`; CAS via swapCid, `CasError` → mark cycle dirty and re-run once) → write tombstone records for `deleteRemote` → save updated index (new base = post-op content, new cid from put results).

**Step 4:** Run → PASS. **Step 5:** Commit: `feat: sync engine executes reconciler ops with encryption`

### Task 16: Two-device scenario suite + fuzz

**Files:**
- Test: `tests/sync/scenarios.test.ts`

**Step 1:** Scripted scenarios, each a failing test first, then verified green (implementation fixes as needed):
- Offline queue: A edits while "offline" (no sync), B edits same note differently, both sync → both devices converge to merged content.
- Conflict mode `'conflict-file'`: overlapping edits → original keeps remote version, local version written to `note (conflict).md` on the merging device.
- Delete vs edit race: A deletes, B edits, both sync → note survives everywhere with B's content.
- Rename: A renames path (record update, same rkey) → B's file moves, count of remote records unchanged.
- CAS race: A and B push concurrently (interleave engine steps) → no lost update; second writer merges.
- **Property test:** 200 iterations, seeded PRNG (no `Math.random` in test bodies — use a seeded generator so failures reproduce): random interleavings of edit/delete/rename/sync across 2–3 simulated devices; invariants: after all devices sync twice with no new edits, all vaults identical, no plaintext in PDS raw dump, every surviving file's content traceable to some device's write (nothing invented, nothing silently lost).

**Step 2:** Commit: `test: two-device scenario and property suite`

---

## Phase 5: Obsidian integration

Glue code — TDD where feasible (store, path utils), manual dev-vault verification otherwise. Each task still commits separately.

### Task 17: IndexedDB sync-state store

**Files:**
- Create: `src/obsidian/store.ts`
- Test: `tests/obsidian/store.test.ts` (uses `fake-indexeddb`)

Implements `IndexStore` from Task 15 against IndexedDB (db name `notesky/<vaultId>`), plus settings blob (cached wrapped master key, KDF params, cursor). Tests: save/load round-trip, load on empty DB → `[]`, corrupted entry → skipped with warning not crash. Commit: `feat: IndexedDB sync state store`

### Task 18: Real PDS client

**Files:**
- Create: `src/obsidian/pds-client.ts`

Implements `PdsClient` over `@atproto/api`'s `Agent`: `com.atproto.repo.putRecord` (with `swapRecord`), `getRecord`, `listRecords` (paginate with cursor until exhausted), `deleteRecord`, mapping swap-mismatch errors (`InvalidSwapError`) to `CasError`. App-password login: `agent.login({ identifier, password })` after resolving the user's handle → PDS host (use `com.atproto.identity.resolveHandle` against `https://public.api.bsky.app`, then read the DID doc's PDS endpoint from `https://plc.directory/<did>`).

Verification: vitest integration test gated behind `NOTESKY_PDS_URL` env var (skipped by default), run manually against the reference PDS in Docker (`ghcr.io/bluesky-social/pds`). Commit: `feat: real PDS client with app-password auth`

### Task 19: Plugin wiring — vault adapter, sync loop, status bar

**Files:**
- Modify: `src/obsidian/main.ts`
- Create: `src/obsidian/vault-adapter.ts`

`ObsidianVaultAdapter` implements `VaultAdapter` over `this.app.vault` (respecting ignore patterns; NFC-normalize all paths at this boundary). `main.ts`: on load — open store, if credentials+passphrase cached then build engine and `sync()` on start, on vault events (debounced 2s), and on a settings-configurable interval (default 5 min). Status bar item: idle/syncing/error with last-sync time. All engine failures surface as `Notice` + status-bar error state, never silent.

Manual verification checklist (dev vault + Docker PDS): create/edit/rename/delete propagate between two copies of the vault; kill Obsidian mid-sync and confirm clean resume. Commit: `feat: wire sync engine into Obsidian lifecycle`

### Task 20: Settings tab + onboarding

**Files:**
- Create: `src/obsidian/settings.ts`

Settings tab: account section (handle, app password → login test button, logout), encryption section (set/enter passphrase — on first device generates salt + writes `app.notesky.vault` record with check value; on later devices verifies against it, with explicit "wrong passphrase" feedback), sync section (interval, ignore patterns textarea, conflict mode dropdown auto-merge/conflict-file), danger section (full re-scan, disconnect). Passphrase-loss warning copy shown at setup, verbatim: *"If you lose this passphrase, encrypted notes on the server cannot be recovered by anyone — including us."* Manual verification: fresh-vault onboarding end-to-end against Docker PDS. Commit: `feat: settings tab and vault onboarding`

### Task 21: Public/private toggle

**Files:**
- Create: `src/obsidian/publish.ts`

Command palette + file context menu: "Notesky: Make note public" / "make private". Public flow: modal listing what will be exposed (title, full text, embedded attachments that will cascade public) → on confirm, republish record with plaintext branch (slug from title, editable in the modal), cascade attachments, add `notesky_public: true` to note frontmatter (the visible badge; also how state survives without the index). Private flow: new note key, republish encrypted, remove frontmatter flag. "Review public notes" command lists all plaintext-branch records with one-click make-private. Unit-test the pure parts (frontmatter add/remove, cascade target extraction from markdown embeds); manual-test the modals. Commit: `feat: public/private note toggle with confirmation`

### Task 22: Hardening pass — initial sync, throttling, mobile

**Files:**
- Modify: `src/sync/engine.ts`, `src/obsidian/main.ts`

Chunk `applyWrites`-style batching (group ops ≤10 per `putRecord` burst with inter-batch delay; upgrade to actual `com.atproto.repo.applyWrites` in `pds-client.ts` for atomicity), progress notice for >50-op syncs ("Syncing 340/2100…"), resumability test (kill mid-initial-sync in the scenario suite → second run completes, no duplicates), Argon2 timing check on mobile-class params (target <2s), quota/rate-limit error mapping to user-readable notices. Commit: `feat: initial-sync throttling, progress, and resilience`

### Task 23: OAuth (riskiest, last)

**Files:**
- Create: `src/obsidian/oauth.ts`; modify `settings.ts`

ATProto OAuth via `@atproto/oauth-client` with client metadata hosted at `https://notesky.app/oauth/client-metadata.json` (needs the domain live — coordinate; until then this task can't ship and app-password remains primary). Redirect: `obsidian://notesky-auth` via `registerObsidianProtocolHandler`. Keep app-password path untouched as fallback. Manual verification on desktop + iOS + Android. Commit: `feat: ATProto OAuth login`

---

## Explicitly deferred (do not build)

Attachments sync (blob upload — next milestone after this plan ships; lexicon already covers it), folder records, `.obsidian`/canvas sync, firehose, blog viewer, comments, suggestions, version history. See the design doc's future-work ledger.

## Done means

`npm run typecheck` clean; `npx vitest run` all green including scenario suite; manual checklist from Tasks 19–21 passes against Docker PDS; two real devices (desktop + one mobile) hold a converged encrypted vault on a test Bluesky account.
