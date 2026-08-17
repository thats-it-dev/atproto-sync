import DiffMatchPatch from 'diff-match-patch';

export interface MergeResult {
  /** false when one or more local patches could not be applied (their edits are absent from merged). */
  clean: boolean;
  merged: string;
}

const dmp = new DiffMatchPatch();

/**
 * Character-level three-way merge (the algorithm Obsidian Sync uses for
 * markdown): patches base→local, fuzzily applied onto remote. Compatible edits
 * to the same line both survive; where a patch cannot apply, remote's text
 * stands and the caller is told via clean=false so the local version can be
 * stashed rather than silently lost.
 */
export function merge3(base: string, local: string, remote: string): MergeResult {
  if (local === base) return { clean: true, merged: remote };
  if (remote === base || remote === local) return { clean: true, merged: local };
  const patches = dmp.patch_make(base, local);
  const [merged, applied] = dmp.patch_apply(patches, remote);
  return { clean: applied.every(Boolean), merged };
}
