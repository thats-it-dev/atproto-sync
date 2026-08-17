/**
 * Pure sync reconciler: compares local files, decrypted remote notes, and the
 * last-synced index, and decides what has to happen. No I/O, no crypto.
 */

export interface LocalFile {
  path: string;
  content: string;
}

export interface RemoteNote {
  rkey: string;
  cid: string;
  path: string;
  content: string;
  deleted?: boolean;
}

export interface IndexEntry {
  path: string;
  rkey: string;
  /** Content both sides agreed on at last sync (merge base). */
  baseContent: string;
  /** Remote cid seen at last sync. */
  lastCid: string;
  /** Owning collection; absent on legacy entries (implies app.notesky.note). */
  collection?: string;
}

export type Op =
  | { kind: 'push'; path: string; rkey: string; content: string; swapCid: string }
  | { kind: 'pushCreate'; path: string; content: string }
  | { kind: 'pull'; path: string; rkey: string; content: string; cid: string }
  | { kind: 'pullCreate'; path: string; rkey: string; content: string; cid: string }
  | { kind: 'merge'; path: string; rkey: string; base: string; local: string; remote: string; swapCid: string }
  | { kind: 'deleteRemote'; rkey: string; path: string; swapCid: string }
  | { kind: 'deleteLocal'; path: string; rkey: string };

export function reconcile(
  local: LocalFile[],
  remote: RemoteNote[],
  index: IndexEntry[]
): Op[] {
  const ops: Op[] = [];

  // Canonicalize: concurrent create/resurrect races can leave several live
  // records at one path. The lowest rkey wins everywhere (deterministic across
  // devices); losers are deleted, and their content folds back in through the
  // same-path create-merge below.
  const liveByPath = new Map<string, RemoteNote[]>();
  for (const n of remote) {
    if (n.deleted) continue;
    const group = liveByPath.get(n.path);
    if (group) group.push(n);
    else liveByPath.set(n.path, [n]);
  }
  const loserRkeys = new Set<string>();
  for (const group of liveByPath.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => (a.rkey < b.rkey ? -1 : 1));
    for (const loser of sorted.slice(1)) {
      loserRkeys.add(loser.rkey);
      ops.push({ kind: 'deleteRemote', rkey: loser.rkey, path: loser.path, swapCid: loser.cid });
    }
  }
  remote = remote.filter((n) => !loserRkeys.has(n.rkey));

  const remoteByRkey = new Map(remote.map((n) => [n.rkey, n]));
  // Index entries whose record vanished (canonicalization loser, or deleted
  // without tombstone) are dropped: their local file re-enters as a create.
  index = index.filter((e) => remoteByRkey.has(e.rkey));

  const localByPath = new Map(local.map((f) => [f.path, f]));
  const indexByRkey = new Map(index.map((e) => [e.rkey, e]));
  const indexByPath = new Map(index.map((e) => [e.path, e]));
  const remoteByPath = new Map(remote.filter((n) => !n.deleted).map((n) => [n.path, n]));

  // Rename detection: an index entry whose file vanished, paired with an
  // unindexed local file of identical content, is a move — push the new path
  // onto the same rkey instead of delete+create.
  const renamedRkeys = new Set<string>();
  const renamedPaths = new Set<string>();
  for (const entry of index) {
    if (localByPath.has(entry.path)) continue;
    const rec = remoteByRkey.get(entry.rkey);
    if (!rec || rec.deleted || rec.cid !== entry.lastCid) continue;
    const moved = local.find(
      (f) =>
        !indexByPath.has(f.path) &&
        !remoteByPath.has(f.path) &&
        !renamedPaths.has(f.path) &&
        f.content === entry.baseContent
    );
    if (moved) {
      ops.push({
        kind: 'push',
        path: moved.path,
        rkey: entry.rkey,
        content: moved.content,
        swapCid: rec.cid,
      });
      renamedRkeys.add(entry.rkey);
      renamedPaths.add(moved.path);
    }
  }

  // Paths whose local file a deleteLocal op will remove this cycle: an
  // unindexed remote at such a path is pulled (ordered after the delete).
  const vacatedPaths = new Set<string>();

  // Indexed notes: the three-way comparison pivots on the index entry.
  for (const entry of index) {
    if (renamedRkeys.has(entry.rkey)) continue;
    const rec = remoteByRkey.get(entry.rkey);
    // Local file is looked up at the remote's current path if it moved, else the indexed path.
    const localFile = localByPath.get(entry.path);

    if (!rec) continue; // remote record vanished without tombstone: nothing to reconcile against

    const remoteChanged = rec.cid !== entry.lastCid;

    if (!localFile) {
      // Local file deleted since last sync.
      if (remoteChanged && !rec.deleted) {
        // Edit wins over local delete: restore the remote edit.
        ops.push({ kind: 'pull', path: rec.path, rkey: entry.rkey, content: rec.content, cid: rec.cid });
      } else if (!rec.deleted) {
        ops.push({ kind: 'deleteRemote', rkey: entry.rkey, path: entry.path, swapCid: rec.cid });
      }
      // Deleted on both sides: nothing to do.
      continue;
    }

    const localChanged = localFile.content !== entry.baseContent;

    if (rec.deleted) {
      // Remote tombstoned.
      if (localChanged) {
        // Edit wins over remote delete: resurrect with the local edit.
        ops.push({ kind: 'push', path: localFile.path, rkey: entry.rkey, content: localFile.content, swapCid: rec.cid });
      } else {
        ops.push({ kind: 'deleteLocal', path: localFile.path, rkey: entry.rkey });
        vacatedPaths.add(localFile.path);
      }
      continue;
    }

    if (!localChanged && !remoteChanged) continue;
    if (localChanged && !remoteChanged) {
      ops.push({
        kind: 'push',
        path: localFile.path,
        rkey: entry.rkey,
        content: localFile.content,
        swapCid: rec.cid,
      });
    } else if (!localChanged && remoteChanged) {
      ops.push({
        kind: 'pull',
        path: rec.path,
        rkey: entry.rkey,
        content: rec.content,
        cid: rec.cid,
      });
      if (rec.path !== entry.path) {
        // Remote rename: pulling moves the file, vacating its old path for
        // any unindexed remote that now lives there.
        vacatedPaths.add(entry.path);
      }
    } else {
      // Both changed: three-way merge, CASing against the remote we merged with.
      ops.push({
        kind: 'merge',
        path: localFile.path,
        rkey: entry.rkey,
        base: entry.baseContent,
        local: localFile.content,
        remote: rec.content,
        swapCid: rec.cid,
      });
    }
  }

  // Unindexed local files: new on this device.
  for (const f of local) {
    if (indexByPath.has(f.path) || renamedPaths.has(f.path)) continue;
    const rec = remoteByPath.get(f.path);
    if (rec && !indexByRkey.has(rec.rkey)) {
      // Simultaneous create on both sides at the same path: merge with empty base.
      ops.push({
        kind: 'merge',
        path: f.path,
        rkey: rec.rkey,
        base: '',
        local: f.content,
        remote: rec.content,
        swapCid: rec.cid,
      });
    } else if (!rec) {
      ops.push({ kind: 'pushCreate', path: f.path, content: f.content });
    }
  }

  // Unindexed remote records: created elsewhere, unseen here.
  for (const rec of remote) {
    if (rec.deleted || indexByRkey.has(rec.rkey)) continue;
    // A local file at this path blocks the pull (same-path create merges above)
    // unless a deleteLocal op is vacating it this cycle.
    if (localByPath.has(rec.path) && !vacatedPaths.has(rec.path)) continue;
    ops.push({
      kind: 'pullCreate',
      path: rec.path,
      rkey: rec.rkey,
      content: rec.content,
      cid: rec.cid,
    });
  }

  return ops;
}
