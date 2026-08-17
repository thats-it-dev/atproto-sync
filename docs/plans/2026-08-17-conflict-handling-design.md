# Conflict handling v2: character-level merge

**Status:** approved 2026-08-17. Replaces the line-level merge + conflict-marker
behavior shipped with the initial plugin implementation.

## Problem

The original design merged concurrent edits line-by-line (`node-diff3`) and, on
overlap, wrote git-style conflict markers into the note — then synced the
markers to every device. Markers in prose are unacceptable, and a
`conflict-file` alternate mode just relocated the mess.

## Decision

Merge concurrent edits at the **character level** with Google's
diff-match-patch, the same algorithm Obsidian Sync uses for markdown. Compute
patches `base → local` and fuzzily apply them onto `remote`:

- **All patches apply** (the overwhelming case, including most same-line
  edits): the merged text — both sides' edits — becomes the note everywhere.
  Silent; no winner is chosen, so no timestamps, no device-clock trust, no
  configuration.
- **Any patch fails to apply** (surrounding text rewritten too heavily): the
  merged result still wins in place (remote's text stands where the patch
  failed), and the full local version is stashed at
  `Notesky Conflicts/<date> <note name>.md` on the merging device, with a
  notice. Nothing is ever silently lost.

The stash folder is device-local: the engine itself excludes it from
reconciliation, so stashes never sync, push, or clutter other devices.

Merging stays a pure deterministic function of `(base, local, remote)`;
CAS serializes concurrent merges exactly as before, so the convergence
properties (and the fuzz suite that guards them) are unchanged in structure.

## Consequences

- `ConflictMode` (`auto` / `conflict-file`), the settings dropdown, and the
  marker-emitting merge path are deleted.
- `node-diff3` is replaced by `diff-match-patch`.
- Known trade-off, shared with Obsidian Sync: a true collision can merge into
  slightly awkward prose ("both edits survive"). Unlike Obsidian Sync, the
  pre-merge local text is recoverable from the conflicts folder rather than
  requiring server-side version history.
- Server-side version history remains future work (see the sync design doc's
  deferred ledger); when it lands, the stash folder can retire in its favor.

## Test impact

- `merge.ts` unit tests rewritten for char-level semantics: non-overlapping
  edits, same-line compatible edits (the case line-level merging cannot
  handle), heavy-rewrite patch failure, identity cases.
- Engine tests: stash-on-failure (path, content, exclusion from sync), notice
  via `onWarning`.
- Scenario suite: conflict scenarios assert merged-both-edits instead of
  markers; the `conflict-file` scenario is replaced by a stash scenario.
- Fuzz invariants: convergence and encryption-at-rest unchanged. The
  "nothing invented" invariant moves from line granularity (every line is some
  device's write) to token granularity (every token-shaped substring in a
  surviving file was actually written by some device), since char-level merges
  legitimately splice within a line.
