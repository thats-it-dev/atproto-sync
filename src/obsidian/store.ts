import type { IndexStore } from '../sync/engine';
import type { IndexEntry } from '../sync/reconcile';

const STORE_NAME = 'kv';
const INDEX_KEY = 'index';
const SETTINGS_KEY = 'settings';

/** Persisted plugin settings: cached wrapped master key, KDF params, sync cursor, etc. */
export type SettingsBlob = Record<string, unknown>;

function isIndexEntry(value: unknown): value is IndexEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.path === 'string' &&
    typeof e.rkey === 'string' &&
    typeof e.baseContent === 'string' &&
    typeof e.lastCid === 'string'
  );
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** IndexStore + settings blob persisted in IndexedDB, one database per vault. */
export class IndexedDbStore implements IndexStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly vaultId: string) {}

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      const req = indexedDB.open(`notesky/${this.vaultId}`, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE_NAME);
      };
      this.dbPromise = request(req as IDBRequest<IDBDatabase>);
    }
    return this.dbPromise;
  }

  private async get(key: string): Promise<unknown> {
    const db = await this.open();
    const tx = db.transaction(STORE_NAME, 'readonly');
    return request(tx.objectStore(STORE_NAME).get(key));
  }

  private async put(key: string, value: unknown): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await request(tx.objectStore(STORE_NAME).put(value, key));
  }

  async load(): Promise<IndexEntry[]> {
    const stored = await this.get(INDEX_KEY);
    if (stored === undefined || stored === null) return [];
    if (!Array.isArray(stored)) {
      console.warn('Notesky: sync index is not an array; starting from empty');
      return [];
    }
    const entries: IndexEntry[] = [];
    for (const item of stored) {
      if (isIndexEntry(item)) {
        entries.push(item);
      } else {
        console.warn('Notesky: skipping corrupted sync index entry', item);
      }
    }
    return entries;
  }

  async save(entries: IndexEntry[]): Promise<void> {
    await this.put(INDEX_KEY, entries);
  }

  async loadSettings(): Promise<SettingsBlob | null> {
    const stored = await this.get(SETTINGS_KEY);
    return typeof stored === 'object' && stored !== null ? (stored as SettingsBlob) : null;
  }

  async saveSettings(settings: SettingsBlob): Promise<void> {
    await this.put(SETTINGS_KEY, settings);
  }

  /** Test hook / escape hatch: write an arbitrary value at a key. */
  async saveRaw(key: string, value: unknown): Promise<void> {
    await this.put(key, value);
  }
}
