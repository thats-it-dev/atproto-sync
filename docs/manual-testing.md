# Notesky Sync — manual testing guide

End-to-end verification against a local reference PDS, covering the manual
checklists from the implementation plan (Tasks 19–21). Everything runs on one
machine; nothing touches the real network except the initial Docker pull.

## 1. Start the local PDS

```bash
docker run -d --name notesky-test-pds -p 3000:3000 \
  -v notesky-pds-data:/pds \
  -e PDS_HOSTNAME=localhost \
  -e PDS_PORT=3000 \
  -e PDS_JWT_SECRET=$(openssl rand -hex 16) \
  -e PDS_ADMIN_PASSWORD=admin-test-pass \
  -e PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=$(openssl rand -hex 32) \
  -e PDS_DATA_DIRECTORY=/pds \
  -e PDS_BLOBSTORE_DISK_LOCATION=/pds/blocks \
  -e PDS_DID_PLC_URL=https://plc.directory \
  -e PDS_INVITE_REQUIRED=false \
  -e PDS_SERVICE_HANDLE_DOMAINS=.test \
  -e PDS_DEV_MODE=true \
  ghcr.io/bluesky-social/pds:latest

curl -s http://localhost:3000/xrpc/_health   # → {"version":"..."}
```

Create the test account (`.localhost` is a banned handle TLD; `.test` works in
dev mode):

```bash
curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.createAccount \
  -H 'Content-Type: application/json' \
  -d '{"handle":"tester.test","email":"tester@example.com","password":"notesky-test-pass"}'
```

Cleanup afterwards: `docker rm -f notesky-test-pds && docker volume rm notesky-pds-data`.

## 2. Automated integration tests (run these first)

```bash
NOTESKY_PDS_URL=http://localhost:3000 \
NOTESKY_HANDLE=tester.test \
NOTESKY_PASSWORD=notesky-test-pass \
pnpm vitest run tests/obsidian/pds-client.integration.test.ts tests/sync/engine-live.integration.test.ts
```

Both must pass before bothering with the UI steps.

## 3. Install the plugin into two dev vaults

Two vaults simulate two devices. **Give them different folder names** — local
sync state is stored per vault name.

```bash
pnpm run build   # produces main.js

mkdir -p ~/notesky-dev/{vault-a,vault-b}
# Open each folder once in Obsidian (Open folder as vault) so .obsidian exists,
# then:
for v in vault-a vault-b; do
  mkdir -p ~/notesky-dev/$v/.obsidian/plugins
  ln -s "$(pwd)" ~/notesky-dev/$v/.obsidian/plugins/notesky-sync
done
```

In each vault: Settings → Community plugins → turn off Restricted mode →
enable **Notesky Sync**. The status bar should show `Notesky: synced`.

## 4. Onboarding (Task 20 checklist)

In **vault-a** → Settings → Notesky Sync:

1. Handle: `tester.test`
2. PDS URL (advanced): `http://localhost:3000`
3. App password: `notesky-test-pass` → **Test login** → expect "login OK".
4. Vault passphrase: pick one → **Set up**. Expect the passphrase-loss warning
   to be visible, then "encryption set up".
5. In **vault-b**, repeat with the same account. First try a **wrong**
   passphrase → expect "wrong passphrase for this vault". Then the right one →
   "passphrase verified".

## 5. Sync walkthrough (Task 19 checklist)

All edits should propagate within ~2s + one sync interval; use the command
palette → "Notesky Sync: Sync now" to force either side.

- **Create** `hello.md` in vault-a → appears in vault-b.
- **Edit** it in vault-b → edit arrives in vault-a.
- **Rename** it in vault-a → file moves in vault-b.
- **Delete** it in vault-b → disappears from vault-a.
- **Conflict (compatible):** with both vaults synced, edit the *start* of a
  sentence in vault-a and the *end* of the same sentence in vault-b before
  syncing either; sync both. Both edits should survive in one merged sentence —
  no markers, no copies, no notice.
- **Conflict (collision):** make a small edit in vault-a while completely
  rewriting the whole note in vault-b; sync b, then a. Vault-a should end up
  with b's rewrite, show a notice, and hold vault-a's version under
  `Sync Conflicts/`. That folder must never appear in vault-b.
- **Kill mid-sync:** put ~200 notes in vault-a (script them), quit Obsidian
  (Cmd-Q) while the progress notice is up, reopen → sync resumes and completes;
  spot-check no duplicate or missing notes in vault-b afterwards.

**Attachments:**

- Drop an image into vault-a (paste into a note or add the file directly) →
  the file appears in vault-b with identical bytes.
- Edit/delete/rename the image in either vault → propagates like notes.
- Add a file larger than 5MB → a notice reports it as too large, it appears
  under Settings → Notesky Sync → "Skipped files", and it stays local-only.
- Check at rest: the `app.notesky.attachment` records (curl below, with
  `collection=app.notesky.attachment`) show no filename, and the blob is not
  the original bytes.

Verify encryption at rest (no auth needed — repos are public):

```bash
curl -s 'http://localhost:3000/xrpc/com.atproto.repo.listRecords?repo=tester.test&collection=app.notesky.note&limit=5'
```

Expect base64 ciphertext only — no note text, no paths, no titles.

## 6. Public toggle (Task 21 checklist)

1. In vault-a, open a note that embeds an image → command palette → "Notesky
   Sync: Make note public". The modal must list title, text, and the embedded
   image (published unencrypted); the slug is editable. Confirm. After sync,
   the image's attachment record shows its real path/mimeType and the blob is
   fetchable as the raw image; making the note private re-encrypts it (unless
   another public note still embeds it).
2. The note gains `notesky_public: true` frontmatter; the `listRecords` curl
   above now shows this note's text/slug in plaintext (only this one).
3. Vault-b receives the frontmatter change and its record stays public.
4. "Review public notes" → the note is listed → **Make private** → frontmatter
   gone, curl shows ciphertext again.
5. File-context-menu "Notesky: toggle public" round-trips the same way.

## 7. OAuth (needs notesky.app live and a real Bluesky account)

1. Verify hosting: `curl https://notesky.app/oauth/client-metadata.json` returns
   the metadata JSON; `https://notesky.app/oauth/callback` loads the bounce page.
2. In a fresh vault (no PDS URL override): enter your handle → **Sign in with
   Bluesky** → browser opens your PDS login → approve → Obsidian reopens with
   "signed in as did:…". Set/enter the passphrase as usual.
3. Restart Obsidian → the session restores without re-auth (tokens refresh via
   the stored DPoP session).
4. Log out → sign-in state clears; app-password login still works as before.
5. Repeat on iOS and Android.

## 8. Acceptance (from the plan's "Done means")

`pnpm run typecheck` clean; `pnpm vitest run` green; sections 4–6 above pass;
finally, two real devices (desktop + one mobile) against a test Bluesky
account — same steps as sections 4–5, without the PDS URL override.
