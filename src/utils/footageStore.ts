// Keeps the user's source footage (an attached video file or a downloaded YouTube section) in this browser's
// IndexedDB so it survives reloads and reopening a project. Video files are never sent to the server: projects are
// saved as JSON with a 512 KB cap, and the footage is the user's own copy of their video.
//
// Two object stores: `meta` (small records, read and rewritten on every access for LRU) and `blobs` (the video).
// Keeping them apart means touching `lastUsed` never rewrites a multi-hundred-MB Blob.

/** Total bytes of footage kept in this browser before the least recently used entries are evicted. */
export const FOOTAGE_STORE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const DB_NAME = 'forge-footage';
const DB_VERSION = 1;
const META = 'meta';
const BLOBS = 'blobs';

export interface FootageMeta {
  key: string;
  name: string;
  offset: number;
  end?: number;
  size: number;
  savedAt: number;
  lastUsed: number;
}

export interface FootageRecord extends FootageMeta {
  blob: Blob;
}

/** Why a put did not keep the footage. `too_large`/`quota`: storage refused it; `unavailable`: no IndexedDB. */
export class FootageStoreError extends Error {
  constructor(public reason: 'too_large' | 'quota' | 'unavailable', message: string) {
    super(message);
    this.name = 'FootageStoreError';
  }
}

/** Store key: one footage file per project (or unsaved draft) and source video. */
export function footageKey(projectKey: string, videoKey: string): string {
  return `${projectKey}::${videoKey}`;
}

/**
 * Pure LRU planning: which existing entries to evict so `incomingSize` fits under `capBytes`. Entries with the
 * same key as the incoming one are replaced anyway, so they are always evicted and never count against the cap.
 * Returns null when the incoming file alone is larger than the cap.
 */
export function planEviction(
  existing: Array<Pick<FootageMeta, 'key' | 'size' | 'lastUsed'>>,
  incoming: { key: string; size: number },
  capBytes = FOOTAGE_STORE_MAX_BYTES,
): string[] | null {
  if (incoming.size > capBytes) return null;
  const evict = existing.filter((e) => e.key === incoming.key).map((e) => e.key);
  const others = existing.filter((e) => e.key !== incoming.key).sort((a, b) => a.lastUsed - b.lastUsed);
  let total = others.reduce((sum, e) => sum + e.size, 0) + incoming.size;
  for (const e of others) {
    if (total <= capBytes) break;
    evict.push(e.key);
    total -= e.size;
  }
  return evict;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new FootageStoreError('unavailable', 'This browser has no IndexedDB (private mode?).'));
  }
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgrading the schema: let it, and reopen next time.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        reject(new FootageStoreError('unavailable', req.error?.message || 'Could not open browser storage.'));
      };
      req.onblocked = () => {
        dbPromise = null;
        reject(new FootageStoreError('unavailable', 'Browser storage is busy in another tab.'));
      };
    });
  }
  return dbPromise;
}

const isQuotaError = (e: unknown) =>
  e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');

function run<T>(
  mode: IDBTransactionMode,
  body: (meta: IDBObjectStore, blobs: IDBObjectStore) => T | Promise<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction([META, BLOBS], mode);
        let result: T;
        Promise.resolve(body(tx.objectStore(META), tx.objectStore(BLOBS))).then((r) => (result = r), reject);
        tx.oncomplete = () => resolve(result);
        const fail = () => {
          const err = tx.error;
          reject(isQuotaError(err) ? new FootageStoreError('quota', 'Browser storage is full.') : err || new Error('Storage transaction failed'));
        };
        tx.onerror = fail;
        tx.onabort = fail;
      }),
  );
}

const reqP = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

async function allMeta(): Promise<FootageMeta[]> {
  return run('readonly', (meta) => reqP(meta.getAll() as IDBRequest<FootageMeta[]>));
}

/** Reads the footage for `key` and marks it as recently used. Resolves null when absent or storage is unavailable. */
export async function getFootage(key: string): Promise<FootageRecord | null> {
  try {
    return await run('readwrite', async (meta, blobs) => {
      const m = (await reqP(meta.get(key))) as FootageMeta | undefined;
      if (!m) return null;
      const blob = (await reqP(blobs.get(key))) as Blob | undefined;
      if (!blob) {
        meta.delete(key); // orphaned metadata (e.g. a write interrupted mid-way)
        return null;
      }
      const touched = { ...m, lastUsed: Date.now() };
      meta.put(touched);
      return { ...touched, blob };
    });
  } catch {
    return null;
  }
}

/**
 * Stores footage under `key`, evicting least recently used entries to stay under FOOTAGE_STORE_MAX_BYTES.
 * Throws FootageStoreError when the file cannot be kept (too large, browser quota, no IndexedDB).
 */
export async function putFootage(
  key: string,
  data: { blob: Blob; name: string; offset: number; end?: number },
  capBytes = FOOTAGE_STORE_MAX_BYTES,
): Promise<void> {
  const existing = await allMeta();
  const evict = planEviction(existing, { key, size: data.blob.size }, capBytes);
  if (!evict) {
    throw new FootageStoreError('too_large', `The video is larger than the ${Math.round(capBytes / 1024 ** 3)} GB kept in this browser.`);
  }
  const now = Date.now();
  const record: FootageMeta = { key, name: data.name, offset: data.offset, size: data.blob.size, savedAt: now, lastUsed: now };
  if (data.end !== undefined) record.end = data.end;
  try {
    await run('readwrite', (meta, blobs) => {
      for (const k of evict) {
        meta.delete(k);
        blobs.delete(k);
      }
      blobs.put(data.blob, key);
      meta.put(record);
    });
  } catch (e) {
    if (e instanceof FootageStoreError) throw e;
    throw isQuotaError(e) ? new FootageStoreError('quota', 'Browser storage is full.') : e;
  }
}

export async function deleteFootage(key: string): Promise<void> {
  try {
    await run('readwrite', (meta, blobs) => {
      meta.delete(key);
      blobs.delete(key);
    });
  } catch {
    // Nothing stored or storage unavailable: nothing to delete.
  }
}

/** Moves footage to a new key (an unsaved draft becoming a saved project). No-op when nothing is stored. */
export async function renameFootage(fromKey: string, toKey: string): Promise<void> {
  if (fromKey === toKey) return;
  try {
    await run('readwrite', async (meta, blobs) => {
      const m = (await reqP(meta.get(fromKey))) as FootageMeta | undefined;
      const blob = (await reqP(blobs.get(fromKey))) as Blob | undefined;
      if (!m || !blob) return;
      blobs.put(blob, toKey);
      meta.put({ ...m, key: toKey, lastUsed: Date.now() });
      meta.delete(fromKey);
      blobs.delete(fromKey);
    });
  } catch {
    // Storage unavailable: the in-memory copy keeps working for this session.
  }
}
