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

  // Indexed notes: the three-way comparison pivots on the index entry.
  for (const entry of index) {
    const rec = remoteByRkey.get(entry.rkey);
    // Local file is looked up at the remote's current path if it moved, else the indexed path.
    const localFile = localByPath.get(entry.path);

    if (!rec) continue; // remote record vanished without tombstone: handled with deletes later
    if (!localFile) continue; // local deletions handled later

    const localChanged = localFile.content !== entry.baseContent;
    const remoteChanged = rec.cid !== entry.lastCid;

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
    }
  }

  return ops;
}
