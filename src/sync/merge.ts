import { merge } from 'node-diff3';

export interface MergeResult {
  clean: boolean;
  merged: string;
}

/** Three-way line merge: base is the common ancestor, local and remote the two edits. */
export function merge3(base: string, local: string, remote: string): MergeResult {
  const r = merge(local, base, remote, {
    stringSeparator: '\n',
    label: { a: 'local', b: 'remote' },
  });
  return { clean: !r.conflict, merged: r.result.join('\n') };
}
