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
  /**
   * Path the remote record had at last sync, when it differs from `path`: a
   * local rename rewrote `path` (see applyRenames) and the record has not
   * been pushed to the new path yet. Absent when both sides agree.
   */
  remotePath?: string;
}

/** A local move observed by the vault adapter: file or folder, old path -> new path. */
export interface RenameHint {
  from: string;
  to: string;
}

/**
 * Rewrite index entries for local renames before reconciling, so a moved
 * file (or folder) is a path change on its existing rkey rather than a
 * delete at the old path plus a create at the new one. Hints apply in order,
 * so chained renames (a->b, then c->a) resolve correctly. Each hint matches
 * the exact path and everything beneath it as a folder.
 */
export function applyRenames(index: IndexEntry[], renames: RenameHint[]): IndexEntry[] {
  if (renames.length === 0) return index;
  let out = index.map((e) => ({ ...e }));
  for (const { from, to } of renames) {
    if (from === to) continue;
    const prefix = `${from}/`;
    out = out.map((e) => {
      let next: string;
      if (e.path === from) next = to;
      else if (e.path.startsWith(prefix)) next = to + e.path.slice(from.length);
      else return e;
      const remotePath = e.remotePath ?? e.path;
      const moved: IndexEntry = { ...e, path: next, remotePath };
      if (next === remotePath) delete moved.remotePath;
      return moved;
    });
  }
  return out;
}

export type Op =
  | { kind: 'push'; path: string; rkey: string; content: string; swapCid: string }
  | { kind: 'pushCreate'; path: string; content: string }
  | { kind: 'pull'; path: string; rkey: string; content: string; cid: string }
  | { kind: 'pullCreate'; path: string; rkey: string; content: string; cid: string }
  | {
      kind: 'merge';
      /** Where the merged result lives (and the path pushed). */
      path: string;
      /** Where the local side currently sits; differs from `path` after a remote rename. */
      localPath: string;
      rkey: string;
      base: string;
      local: string;
      remote: string;
      swapCid: string;
    }
  | { kind: 'adopt'; path: string; rkey: string; content: string; cid: string }
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

    const localContentChanged = localFile.content !== entry.baseContent;
    // A rename hint rewrote entry.path; the record still sits at remotePath.
    const localMoved = entry.remotePath !== undefined && entry.remotePath !== entry.path;
    const remoteMoved = rec.path !== (entry.remotePath ?? entry.path);

    if (rec.deleted) {
      // Remote tombstoned.
      if (localContentChanged) {
        // Edit wins over remote delete: resurrect with the local edit.
        ops.push({ kind: 'push', path: localFile.path, rkey: entry.rkey, content: localFile.content, swapCid: rec.cid });
      } else {
        ops.push({ kind: 'deleteLocal', path: localFile.path, rkey: entry.rkey });
        vacatedPaths.add(localFile.path);
      }
      continue;
    }

    if (!localContentChanged && !localMoved && !remoteChanged) continue;
    if (!remoteChanged) {
      // Local edit and/or local move onto an untouched remote: push both.
      ops.push({
        kind: 'push',
        path: localFile.path,
        rkey: entry.rkey,
        content: localFile.content,
        swapCid: rec.cid,
      });
      continue;
    }
    if (!localContentChanged && !localMoved) {
      ops.push({
        kind: 'pull',
        path: rec.path,
        rkey: entry.rkey,
        content: rec.content,
        cid: rec.cid,
      });
      if (remoteMoved) {
        // Remote rename: pulling moves the file, vacating its old path for
        // any unindexed remote that now lives there.
        vacatedPaths.add(entry.path);
      }
      continue;
    }
    if (!localContentChanged && localMoved) {
      // Local move against a remote edit (and/or remote move): the local path
      // wins, the remote content wins. Pull the content into the moved file,
      // then push the new path onto the record.
      if (rec.content !== entry.baseContent) {
        ops.push({ kind: 'pull', path: localFile.path, rkey: entry.rkey, content: rec.content, cid: rec.cid });
      }
      ops.push({
        kind: 'push',
        path: localFile.path,
        rkey: entry.rkey,
        content: rec.content,
        swapCid: rec.cid,
      });
      continue;
    }

    // Both sides changed content. A local move keeps its path; otherwise the
    // remote's current path (possibly moved) is where the result goes.
    const targetPath = localMoved ? localFile.path : rec.path;
    if (localFile.content === rec.content) {
      // Same content on both sides: only the binding and/or path differ.
      if (targetPath === localFile.path && !remoteMoved) {
        ops.push({ kind: 'adopt', path: localFile.path, rkey: entry.rkey, content: rec.content, cid: rec.cid });
      } else if (localMoved) {
        ops.push({ kind: 'push', path: localFile.path, rkey: entry.rkey, content: localFile.content, swapCid: rec.cid });
      } else {
        ops.push({ kind: 'pull', path: rec.path, rkey: entry.rkey, content: rec.content, cid: rec.cid });
        vacatedPaths.add(entry.path);
      }
      continue;
    }
    // Three-way merge, CASing against the remote we merged with.
    ops.push({
      kind: 'merge',
      path: targetPath,
      localPath: localFile.path,
      rkey: entry.rkey,
      base: entry.baseContent,
      local: localFile.content,
      remote: rec.content,
      swapCid: rec.cid,
    });
    if (targetPath !== localFile.path) vacatedPaths.add(localFile.path);
  }

  // Unindexed local files: new on this device.
  for (const f of local) {
    if (indexByPath.has(f.path) || renamedPaths.has(f.path)) continue;
    const rec = remoteByPath.get(f.path);
    if (rec && !indexByRkey.has(rec.rkey)) {
      if (f.content === rec.content) {
        // Same content on both sides (e.g. after a full re-scan): re-bind only.
        ops.push({ kind: 'adopt', path: f.path, rkey: rec.rkey, content: rec.content, cid: rec.cid });
      } else {
        // Simultaneous create on both sides at the same path: merge with empty base.
        ops.push({
          kind: 'merge',
          path: f.path,
          localPath: f.path,
          rkey: rec.rkey,
          base: '',
          local: f.content,
          remote: rec.content,
          swapCid: rec.cid,
        });
      }
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
