import {
  NOTE_COLLECTION,
  TOMBSTONE_COLLECTION,
  buildEncryptedNote,
  buildPlaintextNote,
} from '../lexicon/build';
import { getPublicSlug, isPublicNote } from '../publish/frontmatter';
import type { NoteRecord, TombstoneRecord } from '../lexicon/types';
import { decryptNote, encryptNote } from '../crypto/note';
import { CasError, PdsClient } from './pds';
import { IndexEntry, LocalFile, RemoteNote, reconcile } from './reconcile';
import { merge3 } from './merge';

export interface VaultAdapter {
  readAll(): Promise<LocalFile[]>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface IndexStore {
  load(): Promise<IndexEntry[]>;
  save(entries: IndexEntry[]): Promise<void>;
}

export type ConflictMode = 'auto' | 'conflict-file';

export interface SyncEngineOptions {
  pds: PdsClient;
  vault: VaultAdapter;
  index: IndexStore;
  masterKey: Uint8Array;
  /** rkey of this vault's app.notesky.vault record. */
  vaultRkey: string;
  conflictMode?: ConflictMode;
  now?: () => string;
  /** Override rkey generation (tests use a deterministic counter). */
  rkeyGen?: () => string;
  /** Max writes per burst/batch (default 10). */
  batchSize?: number;
  /** Pause between bursts so big initial syncs don't hammer the PDS. */
  interBatchDelayMs?: number;
  /** Called after each executed op (and each batch) with (done, total). */
  onProgress?: (done: number, total: number) => void;
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

export class SyncEngine {
  private readonly opts: Required<Pick<SyncEngineOptions, 'conflictMode'>> & SyncEngineOptions;

  constructor(options: SyncEngineOptions) {
    this.opts = { conflictMode: 'auto', ...options };
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

  /** Returns true if a CAS conflict made the cycle dirty. */
  private async syncOnce(): Promise<boolean> {
    const { pds, vault, index: store, masterKey } = this.opts;

    const indexEntries = await store.load();
    const indexByRkey = new Map(indexEntries.map((e) => [e.rkey, e]));
    // One index entry per path: a newly indexed rkey supersedes whatever
    // previously owned that path (e.g. a canonicalization loser).
    const setEntry = (entry: IndexEntry) => {
      for (const [rkey, e] of indexByRkey) {
        if (e.path === entry.path && rkey !== entry.rkey) indexByRkey.delete(rkey);
      }
      indexByRkey.set(entry.rkey, entry);
    };
    const local = await vault.readAll();

    const noteRecords = await pds.listRecords(NOTE_COLLECTION);
    const tombstones = await pds.listRecords(TOMBSTONE_COLLECTION);
    const liveRkeys = new Set(noteRecords.map((r) => r.rkey));
    // Tombstones targeting a live record are stale (the note was resurrected).
    const tombstoneByTarget = new Map(
      tombstones
        .filter((t) => !liveRkeys.has((t.value as TombstoneRecord).target))
        .map((t) => [(t.value as TombstoneRecord).target, t])
    );

    const remote: RemoteNote[] = [];
    for (const rec of noteRecords) {
      const value = rec.value as NoteRecord;
      const payload =
        'ciphertext' in value.content
          ? await decryptNote(value.content, masterKey)
          : { path: value.content.path, title: value.content.title, body: value.content.text };
      remote.push({ rkey: rec.rkey, cid: rec.cid, path: payload.path, content: payload.body });
    }
    for (const [target, tomb] of tombstoneByTarget) {
      const entry = indexByRkey.get(target);
      if (!entry) continue; // never synced that note here: nothing to delete
      remote.push({
        rkey: target,
        cid: tomb.cid,
        path: entry.path,
        content: entry.baseContent,
        deleted: true,
      });
    }

    const tombstonedRkeys = new Set(tombstoneByTarget.keys());
    const allOps = reconcile(local, remote, indexEntries);
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
                collection: NOTE_COLLECTION,
                rkey: this.newRkey(),
                value: await this.encryptToRecord(op.path, op.content),
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
                NOTE_COLLECTION,
                rkey,
                await this.encryptToRecord(op.path, op.content),
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
              NOTE_COLLECTION,
              op.rkey,
              await this.encryptToRecord(op.path, op.content),
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
            await vault.write(op.path, op.content);
            if (previous && previous.path !== op.path) {
              await vault.remove(previous.path); // renamed remotely
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
            const r = merge3(op.base, op.local, op.remote);
            if (!r.clean && this.opts.conflictMode === 'conflict-file') {
              // Remote wins in place; the local version survives as a conflict copy.
              const conflictPath = op.path.replace(/(\.md)?$/i, (ext) => ` (conflict)${ext}`);
              await vault.write(conflictPath, op.local);
              await vault.write(op.path, op.remote);
              setEntry({
                path: op.path,
                rkey: op.rkey,
                baseContent: op.remote,
                lastCid: op.swapCid,
              });
              break;
            }
            const { cid } = await pds.putRecord(
              NOTE_COLLECTION,
              op.rkey,
              await this.encryptToRecord(op.path, r.merged),
              op.swapCid
            );
            await vault.write(op.path, r.merged);
            setEntry({
              path: op.path,
              rkey: op.rkey,
              baseContent: r.merged,
              lastCid: cid,
            });
            break;
          }
          case 'deleteRemote': {
            await pds.deleteRecord(NOTE_COLLECTION, op.rkey, op.swapCid);
            const tombstone: TombstoneRecord = {
              $type: 'app.notesky.tombstone',
              vault: this.opts.vaultRkey,
              target: op.rkey,
              collection: NOTE_COLLECTION,
              deletedAt: this.nowIso(),
            };
            await pds.putRecord(TOMBSTONE_COLLECTION, this.newRkey(), tombstone, null);
            indexByRkey.delete(op.rkey);
            break;
          }
          case 'deleteLocal': {
            await vault.remove(op.path);
            indexByRkey.delete(op.rkey);
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
      await store.save([...indexByRkey.values()]);
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
