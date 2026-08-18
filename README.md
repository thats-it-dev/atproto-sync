# Notesky Sync

Sync your Obsidian vault to your own [ATProto](https://atproto.com) PDS — the
same account you use for Bluesky, Blacksky, Eurosky, or a self-hosted server.
End-to-end encrypted by default.

- **Your storage, your account.** Notes live in your PDS repo as
  `app.notesky.*` records. No third-party sync server, nothing to trust but
  your own host.
- **End-to-end encrypted.** Every note and attachment is encrypted on-device
  (XChaCha20-Poly1305, per-item keys wrapped by an Argon2id passphrase-derived
  master key). Filenames and titles are encrypted too — at rest, your PDS sees
  only ciphertext.
- **Multi-device.** Desktop and mobile converge through three-way sync with
  character-level merging (the same algorithm Obsidian Sync uses). True
  conflicts never lose data: the losing version is kept locally in
  `Notesky Conflicts/`.
- **coming soon - Publish per note.** Toggle a note public and it becomes a plaintext record
  (with its embedded images) that anyone — or any app — can read from your
  PDS. Toggle it back and it re-encrypts with a fresh key.

## Setup

1. Install and enable the plugin.
2. The setup wizard opens: sign in with Bluesky (OAuth, or an app password
   under Advanced), then choose your encryption passphrase.
3. That's it — the status bar shows sync state. Later devices enter the same
   passphrase.

> **Passphrase warning:** if you lose the passphrase, encrypted notes on the
> server cannot be recovered by anyone — including us.

## Notes on limits

- Files larger than your PDS blob limit (5 MB on the reference PDS) stay
  local-only; they're listed under Settings → Skipped files.
- `.obsidian/` configuration does not sync.

## Development

```bash
pnpm install
pnpm test          # vitest suite (unit, scenario, seeded fuzz)
pnpm run build     # produces main.js
```

The sync engine, crypto, and reconciler are plain TypeScript with no Obsidian
dependency and are fully unit-tested; see `docs/` for the design documents and
the manual testing guide (including a local Docker PDS setup).

## License

[MIT](LICENSE)
