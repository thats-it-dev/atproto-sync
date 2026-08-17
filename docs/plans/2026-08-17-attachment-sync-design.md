# Attachment sync design

**Status:** approved 2026-08-17. Extends the vault sync design
(`2026-08-16-notesky-sync-design.md`); prerequisite for multi-device
acceptance testing.

## Scope

Every non-markdown file in the vault syncs — images, PDFs, audio, canvas,
anything — except `.obsidian/`, user ignore patterns, the conflicts stash, and
files over the host's blob size limit. No extension whitelist, no
embedded-only tracking.

## Records and blobs

One `app.notesky.attachment` record per file (lexicon already published):

- File bytes are encrypted client-side (fresh per-attachment key, same
  XChaCha20-Poly1305 `box` primitives as notes) and uploaded via
  `com.atproto.repo.uploadBlob` as `application/octet-stream`.
- The record carries the blob ref plus the metadata union: encrypted
  `{path, mimeType}` sealed like note payloads (filenames stay private), and
  `contentHash` = sha256 of the ciphertext for transport integrity.
- Downloads: `com.atproto.sync.getBlob` (public, serves ciphertext) → decrypt
  → binary write through the vault adapter.

ATProto blob semantics we lean on: content-addressed dedup (unchanged bytes
re-upload nothing, e.g. on rename), and reference-based retention (updating a
record to a new blob lets the PDS garbage-collect the old one — desired).

The sync index stores `baseContent` = sha256 of the plaintext bytes, not the
bytes; a hash is all reconciliation needs and keeps IndexedDB small.

## Reconciliation

The existing pure reconciler is reused unchanged by feeding it hash-as-content
triples: push/pull/creates/deletes/tombstones, rename detection (hash
equality), path canonicalization, and the tombstone collection all carry over.
Notes and attachments run as two passes over their own collections in one sync
cycle, sharing the index store, progress reporting, and CAS retry.

Binary conflict = every attachment `merge` op: no merge is possible, so the
collision rule from the conflict-handling design applies — remote stands,
local bytes stashed to `Notesky Conflicts/<stamp> <name>`, notice via
`onWarning`. No timestamps involved.

## Oversized files

Blob limit discovered once per session from `com.atproto.server.describeServer`
(fallback 5MB, the reference PDS default). Oversized files are excluded from
reconciliation like the conflicts folder, collected per sync, and surfaced as
a warning notice plus a persistent "Skipped files" list in settings. Chunking
is explicitly deferred.

## Public cascade

Making a note public republishes each embedded attachment (via
`extractEmbedTargets`) with plaintext `{path, mimeType}` metadata and the blob
re-uploaded unencrypted, so public viewers can fetch it. Making the note
private re-encrypts them with fresh keys — unless another still-public note
embeds the same file. "Review public notes" also lists public attachments.

## Implementation phases

1. Crypto + lexicon builders (attachment payload encryption, record builder).
2. PdsClient blob surface: `uploadBlob`/`getBlob` + size limit; FakePds gets a
   content-addressed in-memory blob store with a configurable limit.
3. Engine attachment pass: per-collection reconcile, hash content, binary
   merge→stash, oversized exclusion/reporting. Scenario + fuzz coverage.
4. Obsidian glue: binary vault adapter methods, `readAll` widened beyond
   markdown, skipped-files settings section, manual-testing guide update.
5. Public cascade + review modal line.

Gate before resuming manual testing: full suite green including extended fuzz,
and the live Docker-PDS engine test extended with an image round-trip.
