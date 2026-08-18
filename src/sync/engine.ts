import {
  ATTACHMENT_COLLECTION,
  NOTE_COLLECTION,
  TOMBSTONE_COLLECTION,
  buildEncryptedAttachment,
  buildEncryptedNote,
  buildPlaintextAttachment,
  buildPlaintextNote,
  sha256Hex,
} from '../lexicon/build';
import { getPublicSlug, isPublicNote } from '../publish/frontmatter';
import type { AttachmentRecord, NoteRecord, TombstoneRecord } from '../lexicon/types';
import {
  decryptAttachmentBlob,
  decryptAttachmentMeta,
  encryptAttachment,
} from '../crypto/attachment';
import { mimeFromPath, resolvePublicAttachments } from '../publish/cascade';
import { decryptNote, encryptNote } from '../crypto/note';
import { CasError, PdsClient } from './pds';
import { IndexEntry, LocalFile, Op, RemoteNote, reconcile } from './reconcile';
import { merge3 } from './merge';

export interface VaultAdapter {
  readAll(): Promise<LocalFile[]>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** All non-markdown files: path + plaintext sha256 + size (adapters may cache hashes). */
  readAllAttachments(): Promise<Array<{ path: string; hash: string; size: number }>>;
  readBinary(path: string): Promise<Uint8Array>;
  writeBinary(path: string, bytes: Uint8Array): Promise<void>;
}

export interface IndexStore {
  load(): Promise<IndexEntry[]>;
  save(entries: IndexEntry[]): Promise<void>;
}

/** Losing merge content is stashed here; device-local, never reconciled. */
export const CONFLICTS_FOLDER = 'Notesky Conflicts';

export interface SyncEngineOptions {
  pds: PdsClient;
  vault: VaultAdapter;
  index: IndexStore;
  masterKey: Uint8Array;
  /** rkey of this vault's app.notesky.vault record. */
  vaultRkey: string;
  now?: () => string;
  /** Override rkey generation (tests use a deterministic counter). */
  rkeyGen?: () => string;
  /** Max writes per burst/batch (default 10). */
  batchSize?: number;
  /** Pause between bursts so big initial syncs don't hammer the PDS. */
  interBatchDelayMs?: number;
  /** Called after each executed op (and each batch) with (done, total). */
  onProgress?: (done: number, total: number) => void;
  /** Non-fatal problems (e.g. undecryptable records) surface here. */
  onWarning?: (message: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let rkeyCounter = 0;

/** Sortable, collision-resistant rkey. Not a strict ATProto TID; revisit with the real client. */
function generateRkey(): string {
  const time = Date.now().toString(36).padStart(9, '0');
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `${time}${rand}${(rkeyCounter++ % 36).toString(36)}`;
}

type ListedRecord = { rkey: string; cid: string; value: unknown };
type MergeOp = Extract<Op, { kind: 'merge' }>;

/** Cid string out of a BlobRef, whether lex-parsed (CID instance) or raw JSON ({$link}). */
function blobRefString(blob: unknown): string {
  const ref = (blob as { ref?: unknown })?.ref;
  if (!ref) throw new Error('attachment record has no blob ref');
  if (typeof ref === 'string') return ref;
  const link = (ref as { $link?: string }).$link;
  return link ?? String(ref);
}

/**
 * What differs per synced collection (notes vs attachments). The shared
 * sync pass handles listing, tombstones, canonicalization, CAS, batching,
 * progress, and index persistence.
 */
interface CollectionStrategy {
  collection: string;
  /** Local view; content is the comparable string (text for notes, hash tag for attachments). */
  listLocal(): Promise<LocalFile[]>;
  /** Remote view of one listed record. Throws on undecryptable → record is frozen. */
  decryptRemote(rec: ListedRecord): Promise<{ path: string; content: string }>;
  /** Record value to put for a push/pushCreate of this path+content. */
  makeRecord(path: string, content: string): Promise<unknown>;
  /** Write the pulled remote state into the vault. */
  applyPull(path: string, content: string, rkey: string): Promise<void>;
  /**
   * Resolve a merge op. `push`: push this content (and write it locally).
   * `accept`: take the remote side as-is, nothing pushed.
   */
  resolveMerge(op: MergeOp): Promise<{ push: string } | { accept: true }>;
  removeLocal(path: string): Promise<void>;
  unreadableWarning(count: number): string;
}

export class SyncEngine {
  private readonly opts: SyncEngineOptions;

  constructor(options: SyncEngineOptions) {
    this.opts = options;
  }

  async sync(): Promise<void> {
    const dirty = await this.syncOnce();
    if (dirty) {
      // A CAS race lost this cycle; one re-run reconciles against the fresh state.
      await this.syncOnce();
    }
  }

  private nowIso(): string {
    return this.opts.now ? this.opts.now() : new Date().toISOString();
  }

  private newRkey(): string {
    return this.opts.rkeyGen ? this.opts.rkeyGen() : generateRkey();
  }

  private stashPath(notePath: string): string {
    const basename = notePath.split('/').pop() ?? notePath;
    const stamp = this.nowIso().slice(0, 19).replace('T', ' ').replaceAll(':', '.');
    return `${CONFLICTS_FOLDER}/${stamp} ${basename}`;
  }

  private notesStrategy(): CollectionStrategy {
    const { vault, masterKey } = this.opts;
    const engine = this;
    return {
      collection: NOTE_COLLECTION,

      async listLocal() {
        return (await vault.readAll()).filter((f) => !f.path.startsWith(`${CONFLICTS_FOLDER}/`));
      },

      async decryptRemote(rec) {
        const value = rec.value as NoteRecord;
        const payload =
          'ciphertext' in value.content
            ? await decryptNote(value.content, masterKey)
            : { path: value.content.path, title: value.content.title, body: value.content.text };
        return { path: payload.path, content: payload.body };
      },

      async makeRecord(path, content) {
        return engine.encryptToRecord(path, content);
      },

      async applyPull(path, content) {
        await vault.write(path, content);
      },

      async resolveMerge(op) {
        const r = merge3(op.base, op.local, op.remote);
        if (!r.clean) {
          // Some local edits could not be applied: stash the full local
          // version on this device so nothing is lost, and say so.
          await vault.write(engine.stashPath(op.path), op.local);
          engine.opts.onWarning?.(
            `Conflicting edits in "${op.path}" could not be fully merged. ` +
              `Your version is saved in "${CONFLICTS_FOLDER}".`
          );
        }
        return { push: r.merged };
      },

      async removeLocal(path) {
        await vault.remove(path);
      },

      unreadableWarning(count) {
        return (
          `${count} note record(s) could not be decrypted and were skipped. ` +
          'Check that every device uses the same passphrase.'
        );
      },
    };
  }

  private attachmentsStrategy(): CollectionStrategy {
    const { pds, vault, masterKey } = this.opts;
    const engine = this;
    // Listed records this cycle, for pull-time blob resolution.
    const recordByRkey = new Map<string, AttachmentRecord>();
    // Public state is derived: an attachment is public iff some public local
    // note embeds it. Toggling flips the content tag, which triggers a push.
    let publicPaths = new Set<string>();
    const isPublic = (contentTag: string) => contentTag.endsWith(':pub');
    return {
      collection: ATTACHMENT_COLLECTION,

      async listLocal() {
        const limit = await pds.getBlobLimit();
        const all = (await vault.readAllAttachments()).filter(
          (f) => !f.path.startsWith(`${CONFLICTS_FOLDER}/`)
        );
        // Encrypted blob = plaintext + 16-byte MAC.
        const skipped = all.filter((f) => f.size + 16 > limit).map((f) => f.path).sort();
        engine.lastSkippedPaths = skipped;
        if (skipped.length > 0) {
          engine.opts.onWarning?.(
            `${skipped.length} file(s) too large for your PDS to store, not synced: ` +
              skipped.join(', ')
          );
        }
        const skippedSet = new Set(skipped);
        const kept = all.filter((f) => !skippedSet.has(f.path));
        publicPaths = resolvePublicAttachments(
          await vault.readAll(),
          kept.map((f) => f.path)
        );
        return kept.map((f) => ({
          path: f.path,
          content: `${f.hash}:${publicPaths.has(f.path) ? 'pub' : 'enc'}`,
        }));
      },

      async decryptRemote(rec) {
        const value = rec.value as AttachmentRecord;
        recordByRkey.set(rec.rkey, value);
        if ('ciphertext' in value.meta) {
          const meta = await decryptAttachmentMeta(value.meta, masterKey);
          return { path: meta.path, content: `${meta.hash}:enc` };
        }
        return { path: value.meta.path, content: `${value.contentHash}:pub` };
      },

      async makeRecord(path, content) {
        const bytes = await vault.readBinary(path);
        const mimeType = mimeFromPath(path);
        if (isPublic(content)) {
          const uploaded = await pds.uploadBlob(bytes, mimeType);
          return buildPlaintextAttachment({
            vault: engine.opts.vaultRkey,
            path,
            mimeType,
            blob: uploaded.blob,
            contentHash: await sha256Hex(bytes),
            updatedAt: engine.nowIso(),
          });
        }
        const enc = await encryptAttachment(bytes, { path, mimeType }, masterKey);
        const uploaded = await pds.uploadBlob(enc.blob, 'application/octet-stream');
        return buildEncryptedAttachment({
          vault: engine.opts.vaultRkey,
          meta: enc.meta,
          blob: uploaded.blob,
          updatedAt: engine.nowIso(),
        });
      },

      async applyPull(path, _content, rkey) {
        const value = recordByRkey.get(rkey);
        if (!value) throw new Error(`no listed attachment record for ${rkey}`);
        const blobBytes = await pds.getBlob(blobRefString(value.blob));
        const bytes =
          'ciphertext' in value.meta
            ? await decryptAttachmentBlob(value.meta, blobBytes, masterKey)
            : blobBytes;
        await vault.writeBinary(path, bytes);
      },

      async resolveMerge(op) {
        // Binaries cannot merge: remote stands, local bytes are stashed.
        const bytes = await vault.readBinary(op.path);
        await vault.writeBinary(engine.stashPath(op.path), bytes);
        engine.opts.onWarning?.(
          `"${op.path}" was changed on two devices. The other device's version won; ` +
            `yours is saved in "${CONFLICTS_FOLDER}".`
        );
        return { accept: true };
      },

      async removeLocal(path) {
        await vault.remove(path);
      },

      unreadableWarning(count) {
        return (
          `${count} attachment record(s) could not be decrypted and were skipped. ` +
          'Check that every device uses the same passphrase.'
        );
      },
    };
  }

  /** Oversized paths found by the most recent sync (visible in settings). */
  lastSkippedPaths: string[] = [];

  /** Returns true if a CAS conflict made the cycle dirty. */
  private async syncOnce(): Promise<boolean> {
    const forCollection = (entries: IndexEntry[], collection: string) =>
      entries.filter((e) => (e.collection ?? NOTE_COLLECTION) === collection);

    let entries = await this.opts.index.load();
    const notesDirty = await this.syncCollection(
      this.notesStrategy(),
      forCollection(entries, NOTE_COLLECTION),
      forCollection(entries, ATTACHMENT_COLLECTION)
    );
    entries = await this.opts.index.load(); // notes pass may have saved
    const attachmentsDirty = await this.syncCollection(
      this.attachmentsStrategy(),
      forCollection(entries, ATTACHMENT_COLLECTION),
      forCollection(entries, NOTE_COLLECTION)
    );
    return notesDirty || attachmentsDirty;
  }

  /**
   * One reconcile-and-execute pass over a collection. `entries` are this
   * collection's index entries; `otherEntries` are preserved verbatim in
   * every save so passes never clobber each other.
   */
  private async syncCollection(
    strategy: CollectionStrategy,
    indexEntries: IndexEntry[],
    otherEntries: IndexEntry[]
  ): Promise<boolean> {
    const { pds, index: store } = this.opts;

    const indexByRkey = new Map(indexEntries.map((e) => [e.rkey, e]));
    // One index entry per path: a newly indexed rkey supersedes whatever
    // previously owned that path (e.g. a canonicalization loser).
    const setEntry = (entry: IndexEntry) => {
      for (const [rkey, e] of indexByRkey) {
        if (e.path === entry.path && rkey !== entry.rkey) indexByRkey.delete(rkey);
      }
      indexByRkey.set(entry.rkey, { ...entry, collection: strategy.collection });
    };
    const local = await strategy.listLocal();

    // Only this vault's records take part; other vaults on the same account
    // (or stale test data) are invisible.
    const records = (await pds.listRecords(strategy.collection)).filter(
      (r) => (r.value as { vault?: string }).vault === this.opts.vaultRkey
    );
    const tombstones = (await pds.listRecords(TOMBSTONE_COLLECTION)).filter((t) => {
      const value = t.value as TombstoneRecord;
      return value.vault === this.opts.vaultRkey && value.collection === strategy.collection;
    });
    const liveRkeys = new Set(records.map((r) => r.rkey));
    // Tombstones targeting a live record are stale (the note was resurrected).
    const tombstoneByTarget = new Map(
      tombstones
        .filter((t) => !liveRkeys.has((t.value as TombstoneRecord).target))
        .map((t) => [(t.value as TombstoneRecord).target, t])
    );

    const remote: RemoteNote[] = [];
    const unreadableRkeys = new Set<string>();
    for (const rec of records) {
      try {
        const payload = await strategy.decryptRemote(rec);
        remote.push({ rkey: rec.rkey, cid: rec.cid, path: payload.path, content: payload.content });
      } catch {
        // Wrong key or corrupt record: freeze everything related to it this
        // cycle (never delete or overwrite what we cannot read) and warn.
        unreadableRkeys.add(rec.rkey);
      }
    }
    if (unreadableRkeys.size > 0) {
      this.opts.onWarning?.(strategy.unreadableWarning(unreadableRkeys.size));
    }
    // Freeze: an unreadable record's index entry and local file sit out this
    // cycle so the reconciler cannot mistake them for creates or deletes.
    const frozenPaths = new Set(
      indexEntries.filter((e) => unreadableRkeys.has(e.rkey)).map((e) => e.path)
    );
    const activeIndex = indexEntries.filter((e) => !unreadableRkeys.has(e.rkey));
    const activeLocal = local.filter((f) => !frozenPaths.has(f.path));
    for (const [target, tomb] of tombstoneByTarget) {
      const entry = indexByRkey.get(target);
      if (!entry) continue; // never synced that record here: nothing to delete
      remote.push({
        rkey: target,
        cid: tomb.cid,
        path: entry.path,
        content: entry.baseContent,
        deleted: true,
      });
    }

    const tombstonedRkeys = new Set(tombstoneByTarget.keys());
    const allOps = reconcile(activeLocal, remote, activeIndex);
    let dirty = false;

    const batchSize = this.opts.batchSize ?? 10;
    const delayMs = this.opts.interBatchDelayMs ?? 0;
    const total = allOps.length;
    let done = 0;
    let burst = 0;
    const progress = async (count: number) => {
      done += count;
      burst += count;
      this.opts.onProgress?.(done, total);
      if (burst >= batchSize && done < total) {
        burst = 0;
        if (delayMs > 0) await sleep(delayMs);
      }
    };

    // Creates are order-independent of the other ops (paths are disjoint), so
    // they run as atomic batches; everything else executes in reconcile order.
    const creates = allOps.filter((op) => op.kind === 'pushCreate');
    const ops = allOps.filter((op) => op.kind !== 'pushCreate');

    try {
      for (let i = 0; i < creates.length; i += batchSize) {
        const chunk = creates.slice(i, i + batchSize);
        try {
          if (pds.applyCreates) {
            const writes = await Promise.all(
              chunk.map(async (op) => ({
                collection: strategy.collection,
                rkey: this.newRkey(),
                value: await strategy.makeRecord(op.path, op.content),
              }))
            );
            const results = await pds.applyCreates(writes);
            chunk.forEach((op, j) =>
              setEntry({
                path: op.path,
                rkey: writes[j].rkey,
                baseContent: op.content,
                lastCid: results[j].cid,
              })
            );
          } else {
            for (const op of chunk) {
              const rkey = this.newRkey();
              const { cid } = await pds.putRecord(
                strategy.collection,
                rkey,
                await strategy.makeRecord(op.path, op.content),
                null
              );
              setEntry({ path: op.path, rkey, baseContent: op.content, lastCid: cid });
            }
          }
        } catch (err) {
          if (err instanceof CasError) {
            dirty = true;
          } else {
            throw err;
          }
        }
        await progress(chunk.length);
      }

      for (const op of ops) {
        try {
          switch (op.kind) {
            case 'push': {
              // A push onto a tombstoned rkey recreates the record (edit wins over delete).
              const resurrect = tombstonedRkeys.has(op.rkey);
              const { cid } = await pds.putRecord(
                strategy.collection,
                op.rkey,
                await strategy.makeRecord(op.path, op.content),
                resurrect ? null : op.swapCid
              );
              if (resurrect) {
                const tomb = tombstoneByTarget.get(op.rkey);
                if (tomb) await pds.deleteRecord(TOMBSTONE_COLLECTION, tomb.rkey);
              }
              setEntry({
                path: op.path,
                rkey: op.rkey,
                baseContent: op.content,
                lastCid: cid,
              });
              break;
            }
            case 'pull':
            case 'pullCreate': {
              const previous = indexByRkey.get(op.rkey);
              await strategy.applyPull(op.path, op.content, op.rkey);
              if (previous && previous.path !== op.path) {
                await strategy.removeLocal(previous.path); // renamed remotely
              }
              setEntry({
                path: op.path,
                rkey: op.rkey,
                baseContent: op.content,
                lastCid: op.cid,
              });
              break;
            }
            case 'merge': {
              const resolution = await strategy.resolveMerge(op);
              if ('push' in resolution) {
                const { cid } = await pds.putRecord(
                  strategy.collection,
                  op.rkey,
                  await strategy.makeRecord(op.path, resolution.push),
                  op.swapCid
                );
                await strategy.applyPull(op.path, resolution.push, op.rkey);
                setEntry({
                  path: op.path,
                  rkey: op.rkey,
                  baseContent: resolution.push,
                  lastCid: cid,
                });
              } else {
                // Remote side stands as-is; nothing pushed.
                await strategy.applyPull(op.path, op.remote, op.rkey);
                setEntry({
                  path: op.path,
                  rkey: op.rkey,
                  baseContent: op.remote,
                  lastCid: op.swapCid,
                });
              }
              break;
            }
            case 'deleteRemote': {
              await pds.deleteRecord(strategy.collection, op.rkey, op.swapCid);
              const tombstone: TombstoneRecord = {
                $type: 'app.notesky.tombstone',
                vault: this.opts.vaultRkey,
                target: op.rkey,
                collection: strategy.collection,
                deletedAt: this.nowIso(),
              };
              await pds.putRecord(TOMBSTONE_COLLECTION, this.newRkey(), tombstone, null);
              indexByRkey.delete(op.rkey);
              break;
            }
            case 'deleteLocal': {
              await strategy.removeLocal(op.path);
              indexByRkey.delete(op.rkey);
              break;
            }
            case 'adopt': {
              // Local and remote already agree: re-bind the index, no I/O.
              setEntry({
                path: op.path,
                rkey: op.rkey,
                baseContent: op.content,
                lastCid: op.cid,
              });
              break;
            }
          }
        } catch (err) {
          if (err instanceof CasError) {
            dirty = true; // lost a race; the re-run sees fresh cids
          } else {
            throw err;
          }
        }
        await progress(1);
      }
    } finally {
      // Persist partial progress: an interrupted initial sync resumes cleanly.
      await store.save([...otherEntries, ...indexByRkey.values()]);
    }
    return dirty;
  }

  private async encryptToRecord(path: string, content: string): Promise<NoteRecord> {
    if (isPublicNote(content)) {
      // The frontmatter flag is the source of truth: publish plaintext.
      return buildPlaintextNote({
        vault: this.opts.vaultRkey,
        path,
        text: content,
        slug: getPublicSlug(content),
        createdAt: this.nowIso(),
        updatedAt: this.nowIso(),
      });
    }
    const title = (path.split('/').pop() ?? path).replace(/\.md$/i, '');
    const encrypted = await encryptNote({ path, title, body: content }, this.opts.masterKey);
    return buildEncryptedNote({
      vault: this.opts.vaultRkey,
      content: encrypted,
      updatedAt: this.nowIso(),
    });
  }
}
