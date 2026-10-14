import type {
  AttachmentRecord,
  EncryptedAttachmentMeta,
  EncryptedContent,
  NoteRecord,
  PlaintextContent,
} from './types';

export const NOTE_COLLECTION = 'app.notesky.note';
export const VAULT_COLLECTION = 'app.notesky.vault';
export const TOMBSTONE_COLLECTION = 'app.notesky.tombstone';
export const ATTACHMENT_COLLECTION = 'app.notesky.attachment';
export const FOLDER_COLLECTION = 'app.notesky.folder';

export const FORMAT_VERSION = 1;

export function isEncrypted(
  content: EncryptedContent | PlaintextContent
): content is EncryptedContent {
  return 'ciphertext' in content;
}

export function slugify(title: string): string {
  return title
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Title = basename of the path without the .md extension. */
export function titleFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

export interface PlaintextNoteInput {
  vault: string;
  path: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  description?: string;
  tags?: string[];
  slug?: string;
}

export async function buildPlaintextNote(input: PlaintextNoteInput): Promise<NoteRecord> {
  const path = input.path.normalize('NFC');
  const title = titleFromPath(path);
  const content: PlaintextContent = {
    path,
    title,
    slug: input.slug ?? slugify(title),
    text: input.text,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
  };
  return {
    $type: 'app.notesky.note',
    vault: input.vault,
    formatVersion: FORMAT_VERSION,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    contentHash: await sha256Hex(input.text),
    content,
  };
}

export interface EncryptedAttachmentInput {
  vault: string;
  meta: EncryptedAttachmentMeta;
  /** Opaque BlobRef returned by uploadBlob, embedded verbatim. */
  blob: unknown;
  createdAt?: string;
  updatedAt: string;
}

export async function buildEncryptedAttachment(
  input: EncryptedAttachmentInput
): Promise<AttachmentRecord> {
  return {
    $type: 'app.notesky.attachment',
    vault: input.vault,
    formatVersion: FORMAT_VERSION,
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    updatedAt: input.updatedAt,
    contentHash: await sha256Hex(input.meta.ciphertext),
    blob: input.blob,
    meta: input.meta,
  };
}

export interface PlaintextAttachmentInput {
  vault: string;
  path: string;
  mimeType: string;
  /** Opaque BlobRef returned by uploadBlob, embedded verbatim. */
  blob: unknown;
  /** sha256 hex of the (unencrypted) stored bytes. */
  contentHash: string;
  createdAt?: string;
  updatedAt: string;
}

export async function buildPlaintextAttachment(
  input: PlaintextAttachmentInput
): Promise<AttachmentRecord> {
  return {
    $type: 'app.notesky.attachment',
    vault: input.vault,
    formatVersion: FORMAT_VERSION,
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    updatedAt: input.updatedAt,
    contentHash: input.contentHash,
    blob: input.blob,
    meta: { path: input.path.normalize('NFC'), mimeType: input.mimeType },
  };
}

export interface EncryptedNoteInput {
  vault: string;
  content: EncryptedContent;
  createdAt?: string;
  updatedAt: string;
}

export async function buildEncryptedNote(input: EncryptedNoteInput): Promise<NoteRecord> {
  return {
    $type: 'app.notesky.note',
    vault: input.vault,
    formatVersion: FORMAT_VERSION,
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    updatedAt: input.updatedAt,
    contentHash: await sha256Hex(input.content.ciphertext),
    content: input.content,
  };
}
