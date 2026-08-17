import type { LocalFile } from '../sync/reconcile';
import { extractEmbedTargets, isPublicNote } from './frontmatter';

/**
 * An attachment is public iff some public local note embeds it — derived
 * state, nothing stored. Embed targets resolve Obsidian-style: exact path
 * first, then unique basename; ambiguous or unresolvable targets are skipped.
 */
export function resolvePublicAttachments(
  localNotes: LocalFile[],
  attachmentPaths: string[]
): Set<string> {
  const byBasename = new Map<string, string[]>();
  for (const path of attachmentPaths) {
    const base = path.split('/').pop()!;
    const group = byBasename.get(base);
    if (group) group.push(path);
    else byBasename.set(base, [path]);
  }
  const pathSet = new Set(attachmentPaths);

  const result = new Set<string>();
  for (const note of localNotes) {
    if (!isPublicNote(note.content)) continue;
    for (const target of extractEmbedTargets(note.content)) {
      const normalized = target.normalize('NFC');
      if (pathSet.has(normalized)) {
        result.add(normalized);
        continue;
      }
      const candidates = byBasename.get(normalized.split('/').pop()!);
      if (candidates?.length === 1) result.add(candidates[0]);
    }
  }
  return result;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

export function mimeFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
