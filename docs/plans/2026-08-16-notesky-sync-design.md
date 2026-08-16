# Notesky: Obsidian Vault Sync via ATProto — Design

**Date:** 2026-08-16
**Status:** Validated design, pre-implementation
**Domain:** notesky.app · **Lexicon namespace:** `app.notesky.*`

## What this is

An Obsidian plugin that syncs a vault to and from the user's ATProto PDS (Bluesky, Blacksky, Eurosky, or self-hosted). Users install the plugin, log in with their ATProto account, and the vault auto-syncs. Private notes are end-to-end encrypted client-side; a note can be marked public, which publishes it as a readable record.

**Primary job:** multi-device sync, with the PDS as the hub. Backup and publishing fall out of this design; a future notesky.app web viewer, comments, and collaboration are additive later layers.

## Architecture overview

The plugin is the whole system for v1 — **no Notesky server**. Each device runs the plugin; the user's PDS is the sync hub.

Components (TypeScript, standard Obsidian plugin toolchain, desktop + mobile):

1. **Auth module** — ATProto OAuth via `@atproto/oauth-client`, using the `obsidian://` protocol handler for the redirect; app-password fallback for setups where OAuth is flaky. Handle → DID → PDS resolution, so any conformant PDS works.
2. **Crypto module** — Argon2id passphrase KDF → master key; per-note random keys; XChaCha20-Poly1305 for content. All libsodium (works on mobile).
3. **Sync engine** — pure reconciler. Watches vault events for local changes, polls the PDS for remote changes, reconciles via three-way merge.
4. **Local sync state** — IndexedDB: `path ↔ rkey` index, last-synced **base snapshot** per note (enables three-way merge), remote cursor, pending-operation queue for offline edits. Fully rebuildable from vault + PDS if lost (worst case: conflict copies, never data loss).
5. **UI** — settings tab (account, passphrase, sync scope, ignore patterns), per-note "Make public / Make private" command and file-menu item, status-bar sync indicator.

Data flow: local edit → debounce → encrypt (unless public) → `putRecord`. Remote poll → changed records (CID diff) → decrypt → three-way merge against base → write to vault → update base. Everything is queue-based so offline devices catch up cleanly.

## Lexicon: `app.notesky.*`

Five record types. Convention: for encrypted records, **path and title live inside the encrypted payload** (file names are often as sensitive as contents). Cleartext fields on encrypted records are limited to what sync needs: timestamps, content hash, key ID, vault ref.

| Type | Purpose |
|---|---|
| `app.notesky.note` | A markdown file. `content` is a union (below). |
| `app.notesky.attachment` | Binary file: blob ref + the same encrypted/plaintext metadata union. Encrypted attachments = encrypted blob bytes. |
| `app.notesky.folder` | Folders, so empty folders and renames sync. Encrypted-metadata union again. |
| `app.notesky.vault` | Per-vault record: name, KDF salt + params, format version. First thing a new device reads. Vaults have their own rkeys; **every note/attachment/folder record carries a `vault` ref** (multiple vaults per account). |
| `app.notesky.tombstone` | Deletion markers with a retention window, so offline devices learn about deletions instead of re-uploading. |

The `note` content union:

- `app.notesky.note#encrypted` — ciphertext (inline, or blob ref for large notes), wrapped per-note key, nonce, encrypted metadata (path, title).
- `app.notesky.note#plaintext` — markdown text, `path`, `title`, `slug`, `description?`, `tags[]`, `coverImage?`, timestamps. This branch is the publishing surface.

Design points:

- **Actions are not record types.** Create/edit/rename/delete are expressed as record CRUD + tombstones — the idiomatic ATProto shape.
- **Record keys are stable TIDs** and survive the public/private toggle, renames, and moves. This is what makes future comments/likes/suggestions referenceable and keeps shared URLs alive.
- **Every record carries a format version** for forward compatibility; the content union has a discriminator so new formats (permissioned, CRDT) join additively.

### Publishing-ready fields (why they're in v1)

A future blog viewer (`username.notesky.app/<slug>`) needs, from day one:

1. **Stable `slug`** — derived from title at publish time, user-editable, stable thereafter. Viewer resolves slug → record; renames don't break shared URLs.
2. **Reader-facing metadata** in the plaintext branch (title, description, tags, cover image, timestamps).
3. **Public-attachment cascade** — marking a note public also (with a confirmation listing them) marks its embedded attachments public, so a viewer can render images. Wikilinks in public notes resolve to slugs when the target is public; degrade to plain text when private.

The viewer itself is a separate, later, open-sourceable app — PDS-as-CMS. URL identity starts handle-based; "Notesky as ATProto handle provider" (`alice.notesky.app` is the user's handle) is a possible endgame with zero plugin impact.

## Encryption

**Key hierarchy.** Vault passphrase → Argon2id (salt/params in the vault record) → master key. Each note/attachment gets a random per-note key encrypting content + metadata (XChaCha20-Poly1305); the per-note key is stored in its record, wrapped by the master key.

Why per-note keys:

- **Passphrase change** = re-wrap small keys, not re-encrypt all content.
- **Future sharing** = hand someone one note's key; master key never leaves the user. This is the load-bearing hedge for permissioned data and collaboration.
- **Public toggle** = decrypt, strip wrapped key, republish plaintext. Private again = **new** note key (old one considered burned).

**Device experience.** First device generates salt, writes the vault record. New device: log in, enter passphrase, verify against a check value in the vault record (typo fails fast), decrypt as it syncs. Derived key cached locally; opt-in "require passphrase on startup." Lost passphrase = PDS-side private notes unrecoverable by design (local plaintext survives); the UI says this loudly.

**Honest limits.** The PDS operator cannot read private content, paths, or titles — but can see record counts, sizes, and edit timing. Stated plainly to users.

## Sync engine

**Local change detection:** Obsidian vault events → debounced queue; startup scan (mtime/hash vs index) catches edits made while closed. Renames are metadata updates on the existing record.

**Remote change detection:** v1 polls `listRecords` on an interval + on startup/foreground, diffing CIDs against the index. Firehose subscription is a later drop-in behind the same reconciler.

**Reconciliation:**

- Local-only change → push. Remote-only → pull. Both → **three-way merge** for markdown (base vs local vs remote); overlapping hunks fall back per user setting: auto-merge (default, matches Obsidian Sync's behavior but three-way, so cleaner) or conflict file.
- Binaries: last-write-wins; the loser is renamed aside, not destroyed.
- Deletes propagate via tombstones. **Tombstone loses to concurrent edit** (edit wins, note resurrects) — never silently lose writing.

**Write safety:** every push uses ATProto compare-and-swap (`swapRecord`/`swapCommit`) against the last-seen CID; CAS failure = "remote changed, re-reconcile." Closes the device-race hole.

**Batching & resilience:** pushes via `applyWrites` (atomic bursts, respects rate limits); all operations idempotent and resumable — a killed sync recomputes the diff next cycle. Content hashes verify round-trips; decryption/hash failures quarantine instead of overwriting local files.

**Initial sync is a feature:** chunked, throttled, progress UI, fully resumable — a 10k-note vault's first push may take a long time on hosted PDS rate limits. Quota-exceeded errors surface gracefully; settings include ignore patterns / selective sync (`.trash`, template dirs, giant media).

**Filesystem correctness:** paths normalized to NFC at the record boundary (macOS NFD bug class); handle case-insensitive filesystems and cross-platform-invalid characters explicitly.

**Coexistence:** detect obvious signs the vault is also under iCloud/Dropbox/Obsidian Sync and warn (two sync systems fight: echo loops, conflict storms).

## Permissions-data migration plan

Premise: the final shape of ATProto permissioned data is unknown; hold a compatible position rather than bet on a spec. **Per-note keys are the portable primitive** — any plausible mechanism reduces to "let specific DIDs read specific things."

- **Phase 0 (now):** client-side encryption as designed.
- **Phase 1 (permissions ship):** map onto the protocol — per-note keys distributed via the official mechanism; "shared with X" joins "public." Content union grows `#permissioned` — additive, no migration.
- **Phase 2 (opt-in):** "upgrade vault" flow re-publishes encrypted records in native permissioned form at the user's pace; old plugin versions still read the encrypted branch.
- **Escape hatch:** if the protocol ships server-enforced ACLs without E2EE, users choose per-vault: protocol permissions (convenient) or our E2EE (strict). The union supports coexistence.

## Deliberately out of v1 (all confirmed addable without rework)

| Later feature | Why it slots in cleanly |
|---|---|
| Blog viewer / PDS-as-CMS (open-source) | Reads plaintext records; slug + metadata already in lexicon. |
| Comments | `app.notesky.comment` in the **commenter's** repo referencing the note's at-uri + CID (the Bluesky-reply pattern); aggregation is the future AppView's job. Needs only stable rkeys — already guaranteed. |
| Async suggestions | Proposal records in the collaborator's own repo; owner reviews and accepts (owner writes the merge). No shared-write needed. |
| Real-time co-editing | CRDT (Yjs) over an ephemeral transport + PDS snapshots; joins as a new content format in the union. First feature requiring Notesky-run infrastructure. |
| Version history | PDS doesn't retain old record versions accessibly; real history = explicit version records (storage cost). Base snapshots serve merging, not user-facing history. |
| `.obsidian` config, canvas/`.base` sync | Scope call; lexicon extends additively. |
| Firehose-based instant sync | Drop-in behind the reconciler. |
| Handle provider (`alice.notesky.app`) | Viewer-side; zero plugin impact. |

A free win worth marketing: **PDS migration** (Bluesky → Blacksky → self-hosted) carries the whole vault along via standard ATProto repo migration. Zero work for us.

## Testing strategy

- **Sync engine:** pure reconciler tested against an **in-memory fake PDS** (record CRUD + CAS semantics). Scripted two-device scenarios (offline edits, races, rename-vs-edit, delete-vs-edit, tombstone expiry) plus property-based fuzzing of operation interleavings, asserting convergence and no data loss.
- **Merge:** fixture corpus of base/local/remote markdown triples, including frontmatter edits and list reordering.
- **Crypto:** round-trip vectors, wrong-passphrase-fails-fast, cross-platform vectors proving desktop/mobile interop.
- **Integration:** reference PDS in Docker. Real PDSes (Bluesky, Blacksky, Eurosky) and mobile via manual release checklist.

## Top risks (ranked)

1. **Accidental publication** — the worst failure. Mitigations: explicit confirm dialog listing cascading attachments, persistent visual badge on public notes, "review all public notes" panel.
2. **Mobile constraints** — no background sync (sync on open/foreground); Argon2 tuned so unlock is fast on phones.
3. **OAuth inside Obsidian** — the `obsidian://` redirect is the flakiest link; app-password fallback exists for this reason.
4. **Lexicon lock-in** — published lexicons are forever-ish; format versions everywhere, and the lexicon gets the hardest design review.
5. **Hosted-PDS limits** — rate limits and quotas; big-vault-on-Bluesky is the constraint to watch.

## Decision log

| Decision | Choice | Key alternatives rejected |
|---|---|---|
| Core purpose | Multi-device sync via PDS | Backup-only; publishing-first |
| Conflicts | Three-way auto-merge + conflict-file setting; LWW binaries | LWW everywhere (loses writing); CRDT storage (hurts publishing + lexicon simplicity) |
| Encryption | Passphrase → Argon2id master key + per-note wrapped keys | Single vault key (bad sharing story); device-paired random key (unrecoverable + friction) |
| Public notes | One record type, content union | Separate public type (identity churn on toggle); WhiteWind cross-post (possible later add-on) |
| v1 sync scope | Markdown + attachments | Canvas/config deferred |
| Auth | OAuth with app-password fallback | Either alone |
