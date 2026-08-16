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
  const localByPath = new Map(local.map((f) => [f.path, f]));
  const remoteByRkey = new Map(remote.map((n) => [n.rkey, n]));
  const indexByRkey = new Map(index.map((e) => [e.rkey, e]));
  const indexByPath = new Map(index.map((e) => [e.path, e]));
  const remoteByPath = new Map(remote.filter((n) => !n.deleted).map((n) => [n.path, n]));

  // Indexed notes: the three-way comparison pivots on the index entry.
  for (const entry of index) {
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
    if (indexByPath.has(f.path)) continue;
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
    if (localByPath.has(rec.path)) continue; // handled above as same-path create
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
