/** TypeScript mirrors of the lexicons/app/notesky/*.json schemas. */

export interface EncryptedContent {
  keyId: string;
  /** base64: per-note key wrapped by master key */
  wrappedKey: string;
  keyNonce: string;
  contentNonce: string;
  /** base64: XChaCha20-Poly1305 over JSON {path, title, body} */
  ciphertext: string;
}

export interface PlaintextContent {
  path: string;
  title: string;
  slug: string;
  description?: string;
  tags?: string[];
  coverImage?: StrongRef;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface StrongRef {
  uri: string;
  cid: string;
}

export interface NoteRecord {
  $type: 'app.notesky.note';
  /** rkey of the app.notesky.vault record this note belongs to */
  vault: string;
  formatVersion: number;
  createdAt?: string;
  updatedAt: string;
  /** sha256 hex of the stored content bytes (ciphertext when encrypted) */
  contentHash: string;
  content: EncryptedContent | PlaintextContent;
}

export interface KdfParamsRecord {
  alg: string;
  saltB64: string;
  opsLimit: number;
  memLimit: number;
}

export interface CheckValueRecord {
  nonce: string;
  ciphertext: string;
}

export interface VaultRecord {
  $type: 'app.notesky.vault';
  name: string;
  formatVersion: number;
  kdf: KdfParamsRecord;
  checkValue: CheckValueRecord;
  createdAt: string;
}

export interface TombstoneRecord {
  $type: 'app.notesky.tombstone';
  vault: string;
  /** rkey of the deleted record */
  target: string;
  /** NSID of the collection the deleted record belonged to */
  collection: string;
  deletedAt: string;
}

export interface AttachmentMetaPlaintext {
  path: string;
  mimeType: string;
}

export interface AttachmentRecord {
  $type: 'app.notesky.attachment';
  vault: string;
  formatVersion: number;
  createdAt?: string;
  updatedAt: string;
  contentHash: string;
  blob: unknown; // BlobRef, provided by @atproto/api at upload time
  meta: EncryptedContent | AttachmentMetaPlaintext;
}

export interface FolderMetaPlaintext {
  path: string;
}

export interface FolderRecord {
  $type: 'app.notesky.folder';
  vault: string;
  formatVersion: number;
  createdAt?: string;
  updatedAt: string;
  meta: EncryptedContent | FolderMetaPlaintext;
}
