# Attachment Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Sync every non-markdown vault file to the PDS as encrypted blobs with `app.notesky.attachment` records, per `docs/plans/2026-08-17-attachment-sync-design.md`.

**Architecture:** The existing pure reconciler is reused for attachments by feeding it plaintext-hash-as-content triples; the engine grows a second per-collection pass with strategy hooks (notes = text+merge, attachments = bytes+stash-on-conflict). Blob bytes encrypt with the same box primitives; metadata (path, mimeType, plaintext hash) seals like note payloads. Public state for attachments is **derived**, not stored: an attachment is public iff some public local note embeds it.

**Tech Stack:** existing stack + `com.atproto.repo.uploadBlob` / `com.atproto.sync.getBlob`. No new dependencies.

**Conventions:** as the main plan — `./node_modules/.bin/vitest run <file>`, commit per green task, nothing below `src/obsidian/` touches the Obsidian API.

---

## Task 1: Lexicon revision — attachment encrypted meta

The published `attachment.json` encrypted union lacks a nonce for the metadata
ciphertext (only `contentNonce` for the blob). Nothing has shipped; revise it.

**Files:**
- Modify: `lexicons/app/notesky/attachment.json`
- Modify: `src/lexicon/types.ts`

**Step 1:** In `attachment.json`, replace the `encrypted` def's fields with
required `["keyId", "wrappedKey", "keyNonce", "blobNonce", "metaNonce", "ciphertext"]`:
`blobNonce` (nonce for the blob ciphertext), `metaNonce` (nonce for the
metadata ciphertext), `ciphertext` description: "base64: XChaCha20-Poly1305
over JSON {path, mimeType, hash}" where `hash` is sha256 hex of the plaintext
bytes (lets devices reconcile without downloading blobs).

**Step 2:** In `types.ts` add:

```ts
export interface EncryptedAttachmentMeta {
  keyId: string;
  wrappedKey: string;
  keyNonce: string;
  blobNonce: string;
  metaNonce: string;
  ciphertext: string;
}
```

and change `AttachmentRecord.meta` to `EncryptedAttachmentMeta | AttachmentMetaPlaintext`.

**Step 3:** `./node_modules/.bin/tsc --noEmit` clean. Commit: `feat: revise attachment lexicon for split blob/meta nonces`

## Task 2: Attachment crypto

**Files:**
- Create: `src/crypto/attachment.ts`
- Test: `tests/crypto/attachment.test.ts`

**Step 1: failing test**

```ts
import { it, expect } from 'vitest';
import { encryptAttachment, decryptAttachmentMeta, decryptAttachmentBlob } from '../../src/crypto/attachment';

it('hides path/mime in meta, round-trips blob, carries plaintext hash', async () => {
  const master = new Uint8Array(32).fill(9);
  const bytes = new Uint8Array([1, 2, 3, 250, 251]);
  const { meta, blob } = await encryptAttachment(bytes, { path: 'img/Secret Chart.png', mimeType: 'image/png' }, master);
  expect(JSON.stringify(meta)).not.toContain('Secret Chart');
  expect(blob).not.toEqual(bytes);
  const m = await decryptAttachmentMeta(meta, master);
  expect(m.path).toBe('img/Secret Chart.png');
  expect(m.mimeType).toBe('image/png');
  expect(m.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(await decryptAttachmentBlob(meta, blob, master)).toEqual(bytes);
});

it('fails loudly on tampered blob', async () => {
  const master = new Uint8Array(32).fill(9);
  const { meta, blob } = await encryptAttachment(new Uint8Array([7]), { path: 'a.png', mimeType: 'image/png' }, master);
  blob[0] ^= 0xff;
  await expect(decryptAttachmentBlob(meta, blob, master)).rejects.toThrow();
});
```

**Step 2:** Run → FAIL (module not found).

**Step 3:** Implement: one fresh key; blob box (`blobNonce` + returned ciphertext bytes),
meta box over JSON `{path: NFC, mimeType, hash: sha256Hex(bytes)}` (`metaNonce` + `ciphertext` b64),
`wrapKey` for `wrappedKey`/`keyNonce`, `keyId` = 8 random bytes hex. Reuse `box.ts` and `sha256Hex` from `lexicon/build.ts`.
`decryptAttachmentMeta` unwraps key + opens meta box only. `decryptAttachmentBlob` opens the blob box.

**Step 4:** Run → PASS. **Step 5:** Commit: `feat: attachment encryption with private metadata and plaintext hash`

## Task 3: Attachment record builders

**Files:**
- Modify: `src/lexicon/build.ts`
- Test: extend `tests/lexicon/build.test.ts`

Failing test → implement → pass → commit (`feat: attachment record builders`):
`buildEncryptedAttachment({vault, meta, blob, updatedAt})` (contentHash = sha256 of `meta.ciphertext`)
and `buildPlaintextAttachment({vault, path, mimeType, blob, contentHash, updatedAt})` — `blob` is the
opaque BlobRef from upload, embedded verbatim. Test asserts `$type`, required fields, and that
plaintext meta carries path/mimeType.

## Task 4: Blob surface on PdsClient + FakePds

**Files:**
- Modify: `src/sync/pds.ts`, `src/sync/fake-pds.ts`
- Test: extend `tests/sync/fake-pds.test.ts`

**Step 1: failing tests** — interface additions:

```ts
// pds.ts additions:
// uploadBlob(bytes: Uint8Array, mimeType: string): Promise<{ blob: unknown; ref: string }>
//   // blob: opaque BlobRef to embed in a record; ref: cid string for getBlob
// getBlob(ref: string): Promise<Uint8Array>
// getBlobLimit(): Promise<number>
// class BlobTooLargeError extends Error {}
```

Tests: upload/get round-trip; identical bytes → identical `ref` (content-addressed dedup);
upload over the configured limit throws `BlobTooLargeError`; `new FakePds({ blobLimit: 8 })` respected,
default limit generous (16MB) so existing tests never hit it.

**Step 2–4:** FakePds: `ref` = sha256 hex via `crypto.subtle`; store `Map<ref, bytes>`;
`blob` = `{ $type: 'blob', ref: { $link: ref }, mimeType, size }`. Run → PASS.

**Step 5:** Commit: `feat: blob surface on PdsClient with content-addressed fake`

## Task 5: RealPdsClient blob methods

**Files:**
- Modify: `src/obsidian/pds-client.ts`

`uploadBlob` → `agent.uploadBlob(bytes, { encoding: mimeType })`, return
`{ blob: res.data.blob, ref: res.data.blob.ref.toString() }`; map size-related XRPC errors
(`BlobTooLarge`, 413) to `BlobTooLargeError`, others through `mapPdsError`.
`getBlob` → `agent.com.atproto.sync.getBlob({ did: this.did, cid: ref })`, returns `res.data` bytes.
`getBlobLimit` → try `describeServer`, read a limit field if the host reports one, else 5MB constant.
No unit test (thin wrapper); the live integration test (Task 10) covers it.
`tsc` clean. Commit: `feat: real PDS blob upload/download`

## Task 6: Engine refactor to per-collection passes (no behavior change)

**Files:**
- Modify: `src/sync/engine.ts`

Extract the body of `syncOnce` into a private `syncCollection(strategy)` where the strategy carries:
`collection` name, `listLocal(): Promise<LocalFile[]>` (content = text for notes),
`decryptRemote(rec): Promise<{path, content}>`, `makeRecord(path, content|op): Promise<{record, ...}>`,
`applyPull(op): Promise<void>`, `applyConflict(op): Promise<'merged'|'stashed'>` — notes implement
today's exact behavior (merge3, stash on `!clean`). Tombstone filtering gains
`t.collection === strategy.collection`; `deleteRemote` writes the strategy's collection into the tombstone.
The CAS/batch/progress/finally-save loop stays shared.

**Verification:** the FULL suite must stay green with zero test edits — this is a pure refactor.
Run 2× for determinism. Commit: `refactor: engine sync as per-collection strategy passes`

## Task 7: Attachment pass in the engine

**Files:**
- Modify: `src/sync/engine.ts`, `tests/sync/helpers.ts`
- Test: `tests/sync/attachments.test.ts`

**Step 1:** `helpers.ts` — `FakeVault` gains `binaries = new Map<string, Uint8Array>()`,
`writeBinary/readBinary/removeBinary`, and `readAllAttachments()` returning `{path, hash, size}`
(hash via `sha256Hex`). `VaultAdapter` interface gains those four (adapter-side hashing so Obsidian can cache).

**Step 2: failing scenario tests** (each red first, then green):

```ts
it('round-trips an image A→B, encrypted at rest with hidden filename', ...);
// raw dump of app.notesky.attachment contains neither the filename nor plaintext bytes;
// b.vault.readBinary('img/chart.png') equals A's bytes
it('propagates binary edit and delete (tombstone)', ...);
it('rename re-uses the same blob ref (content-addressed dedup)', ...);
it('conflicting binary edits: remote stands, local stashed to Notesky Conflicts', ...);
it('oversized file is skipped with a warning and synced nothing', ...);
// FakePds({blobLimit: 64}); engine onWarning message lists the path; no record created
```

**Step 3:** Implement the attachment strategy: local content = `hash:enc|pub` tag (public tag wired
in Task 8 — hardcode `enc` for now); remote content from `decryptAttachmentMeta().hash` (or record
`contentHash` for plaintext branch); push = readBinary → encryptAttachment → uploadBlob → record;
pull = getBlob → decryptAttachmentBlob → writeBinary; conflict = stash local bytes then apply remote;
oversized filtered pre-reconcile into a `skipped` list surfaced via `onWarning` + `engine.lastSkippedPaths`.

**Step 4:** Full suite green. **Step 5:** Commit: `feat: attachment sync pass with encrypted blobs`

## Task 8: Derived public cascade

**Files:**
- Create: `src/publish/cascade.ts`
- Modify: `src/sync/engine.ts`
- Test: `tests/publish/cascade.test.ts`, extend `tests/sync/attachments.test.ts`

**Step 1: failing tests** for the pure resolver:

```ts
// resolvePublicAttachments(localNotes: LocalFile[], attachmentPaths: string[]): Set<string>
// - embeds from isPublicNote() notes only (extractEmbedTargets)
// - exact path match wins; else unique basename match; ambiguous/missing → skipped
```

**Step 2–3:** Implement; engine computes the set each cycle (notes pass output feeds the attachment
pass), tags local attachment content `hash:pub` when public. Engine test: making a note public flips
its embedded image to a plaintext record + unencrypted blob on the next sync; removing the flag
re-encrypts (new key by construction); an attachment embedded by TWO public notes stays public when
only one goes private.

**Step 4–5:** Suite green; commit: `feat: public attachments derived from public notes`

## Task 9: Fuzz extension

**Files:**
- Modify: `tests/sync/scenarios.test.ts`

Add attachment ops to the property test (seeded bytes: `Uint8Array.from({length: 8}, () => Math.floor(rand()*256))`,
paths like `#img0.bin`): edit/delete/rename alongside note ops. Invariants: (1) vault convergence now
compares `binaries` too (stash excluded); (2) `'#'` never in the attachment collection dump; (3) every
surviving binary's bytes equal exactly some device's write for that path family (binaries never merge).
200 iterations, 3 consecutive full-suite runs identical. Commit: `test: fuzz covers attachment sync`

## Task 10: Obsidian glue + live verification

**Files:**
- Modify: `src/obsidian/vault-adapter.ts`, `src/obsidian/settings.ts`, `src/obsidian/publish.ts`, `docs/manual-testing.md`
- Test: extend `tests/sync/engine-live.integration.test.ts`

**Step 1:** `ObsidianVaultAdapter`: `readAllAttachments()` over `vault.getFiles()` minus `.md`,
ignore patterns, conflicts folder; sha256 cached in a `Map` keyed `path|mtime|size`;
`readBinary`/`writeBinary` via `vault.readBinary`/`createBinary`/`modifyBinary`; folder creation as in `write`.

**Step 2:** Settings: read-only "Skipped files (too large)" list from `plugin.engine?.lastSkippedPaths`;
publish modal wording: embeds "will be published unencrypted"; review modal lists public attachments.

**Step 3:** Live test: push a small PNG-ish byte array from A, assert attachment record + blob round-trip
to B through the Docker PDS, filename absent from the raw record dump. Run env-gated against the
running container.

**Step 4:** `npm run build` clean; update manual-testing.md (attachment walkthrough: image propagates,
oversized file warns, public note exposes its image). Commit: `feat: attachment sync in the Obsidian plugin`

---

## Done means

Full suite green including extended fuzz (3× deterministic); both env-gated integration tests pass
against the Docker PDS; dev-vault walkthrough shows an image syncing A→B encrypted at rest; oversized
file visibly skipped; public note's image fetchable unencrypted, re-encrypted on make-private.
