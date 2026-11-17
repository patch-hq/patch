// The chat list, kept on this device (spec/05 § Loading, "Device copy").
//
// A reload paints the list from here before any network call, then the server's
// list replaces it. The server stays the record: this is a read-only copy of
// what it last sent, rewritten whole each time so a chat deleted or renamed
// elsewhere cannot survive in it.
//
// Only active rows are held. Archived, snoozed and hidden sections load when
// opened, and a row held here that the server's list later omits is dropped.
// Every read is tolerant of a broken store: a copy that cannot be read is no
// copy (the list shows loading until the server answers), never a failure.

import type { ChatRow } from '../stores/types.js';

const DB_NAME = 'patch-chatlist';
const STORE = 'list';
const KEY = 'chats';
/** How many rows to keep. The newest by last update; the rest load from the server. */
export const MAX_CACHED_LIST_ROWS = 300;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn('[patch] chat list cache unavailable:', req.error?.message);
      resolve(null);
    };
  });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('idb transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('idb transaction aborted'));
  });
}

/** The held rows, or null when none are held (or the store cannot be read). */
export async function loadChatList(): Promise<ChatRow[] | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    const rows = (await promisify(
      db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY),
    )) as ChatRow[] | undefined;
    return Array.isArray(rows) && rows.length > 0 ? rows : null;
  } catch (err) {
    console.warn('[patch] chat list cache read failed:', (err as Error).message);
    return null;
  }
}

/** Replace the held copy with these rows (active ones only, newest first, bounded). */
export async function saveChatList(rows: readonly ChatRow[]): Promise<void> {
  const keep = rows
    .filter((r) => r.status === 'active')
    .sort((a, b) => b.lastUpdated - a.lastUpdated)
    .slice(0, MAX_CACHED_LIST_ROWS);
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(keep, KEY);
    await done(tx);
  } catch (err) {
    console.warn('[patch] chat list cache write failed:', (err as Error).message);
  }
}

export async function clearChatList(): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
    await done(tx);
  } catch (err) {
    console.warn('[patch] chat list cache clear failed:', (err as Error).message);
  }
}

/** Test seam: forget the memoised handle so a fresh DB can be opened. */
export function __resetChatListCacheForTests(): void {
  dbPromise = null;
}
