// A chat's transcript, kept on this device (spec/12 § Cold start).
//
// Replay is cheap now that tool bodies stay in the blob store and the answer
// arrives as a few frames instead of thousands. This is the last piece: a
// chat you have already opened should not be downloaded again just because
// you restarted the app. Opening one paints from here immediately, then asks
// the host only for what is newer than the last seq we hold.
//
// The HOST stays the record. This is a cache, never a source of truth:
//   - It holds only DURABLE events — the ones carrying a seq, exactly what a
//     replay would re-send. Live-only frames (deltas, state) are never kept.
//   - It is keyed by branch. A fork, an edit or a branch switch makes the
//     cached track the wrong track, and the whole chat is dropped and
//     refetched rather than merged into something plausible.
//   - Every read is tolerant of a broken store: a cache that cannot be read
//     is NO cache (the chat loads from the host, a little slower), never a
//     chat that fails to open. It is re-derivable; the host's log is not.
//
// One exception to "only events with a seq": a question's ANSWER. The host
// sends `chat.permission_response` without a seq, so it can never be an
// event row here — yet the cached `chat.permission_request` it settles WAS
// kept. Hold only the request and a restart paints the card open and blank
// while the agent already has the answer, and the follow-up replay (seq >
// the highest held) never re-sends the settled pair. So resolutions are kept
// in their own store, keyed by request, and re-applied after the events.
//
// Bounded by chat count, trimmed oldest-opened-first, so a year of chats
// cannot fill a browser's quota.

const DB_NAME = 'patch-transcripts';
const DB_VERSION = 2;
const EVENTS = 'events';
const CHATS = 'chats';
const RESOLUTIONS = 'resolutions';
/** How many chats' transcripts to keep. Beyond this, least-recently-opened go. */
export const MAX_CACHED_CHATS = 40;

/** What a cached chat knows about itself. */
interface CachedChatMeta {
  chatId: string;
  /** The track these events belong to; a different one invalidates them all. */
  branchId: string | null;
  /** Epoch ms this chat was last opened, for trimming. */
  openedAt: number;
}

/** One decision taken on a question, in the order it was taken. */
export interface CachedResolutionStep {
  decision: 'approve' | 'deny';
  answers?: Record<string, string>;
}

export interface CachedResolution {
  chatId: string;
  requestId: string;
  steps: CachedResolutionStep[];
}

export interface CachedTranscript {
  events: unknown[];
  /** Answers given to cached questions; re-apply after the events. */
  resolutions: CachedResolution[];
  branchId: string | null;
}

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
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(EVENTS)) {
        db.createObjectStore(EVENTS, { keyPath: ['chatId', 'seq'] });
      }
      if (!db.objectStoreNames.contains(CHATS)) {
        db.createObjectStore(CHATS, { keyPath: 'chatId' });
      }
      if (!db.objectStoreNames.contains(RESOLUTIONS)) {
        db.createObjectStore(RESOLUTIONS, { keyPath: ['chatId', 'requestId'] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn('[patch] transcript cache unavailable:', req.error?.message);
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

/**
 * The durable seq an event carries, or null if it is not one worth keeping.
 * A negative seq is an optimistic local echo the host has not persisted —
 * caching one would resurrect a message that may never have been sent.
 */
function durableSeq(event: unknown): number | null {
  if (typeof event !== 'object' || event === null) return null;
  const e = event as { seq?: unknown; chatId?: unknown };
  if (typeof e.chatId !== 'string') return null;
  return typeof e.seq === 'number' && Number.isInteger(e.seq) && e.seq >= 0 ? e.seq : null;
}

/** Everything held for a chat, oldest first, or null when nothing is held. */
export async function loadTranscript(chatId: string): Promise<CachedTranscript | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    const tx = db.transaction([EVENTS, CHATS, RESOLUTIONS], 'readonly');
    const rows = await promisify(
      tx.objectStore(EVENTS).getAll(IDBKeyRange.bound([chatId, 0], [chatId, Infinity])),
    );
    if (rows.length === 0) return null;
    const meta = (await promisify(tx.objectStore(CHATS).get(chatId))) as CachedChatMeta | undefined;
    const resolutions = (await promisify(
      tx.objectStore(RESOLUTIONS).getAll(IDBKeyRange.bound([chatId, ''], [chatId, '\uffff'])),
    )) as CachedResolution[];
    return {
      events: (rows as Array<{ event: unknown }>).map((r) => r.event),
      resolutions,
      branchId: meta?.branchId ?? null,
    };
  } catch (err) {
    console.warn('[patch] transcript cache read failed:', (err as Error).message);
    return null;
  }
}

/**
 * Keep these events for `chatId`. Only the durable ones are stored, keyed by
 * seq, so re-delivering an event the cache already holds overwrites it rather
 * than duplicating it — which is what makes a reconnect's overlapping replay
 * safe to feed straight in.
 */
export async function saveEvents(chatId: string, events: unknown[]): Promise<void> {
  const keepable = events
    .map((event) => ({ event, seq: durableSeq(event) }))
    .filter((r): r is { event: unknown; seq: number } => r.seq !== null);
  if (keepable.length === 0) return;
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction([EVENTS, CHATS], 'readwrite');
    const store = tx.objectStore(EVENTS);
    for (const { event, seq } of keepable) store.put({ chatId, seq, event });
    const chats = tx.objectStore(CHATS);
    const existing = (await promisify(chats.get(chatId))) as CachedChatMeta | undefined;
    chats.put({
      chatId,
      branchId: existing?.branchId ?? null,
      openedAt: Date.now(),
    } satisfies CachedChatMeta);
  } catch (err) {
    console.warn('[patch] transcript cache write failed:', (err as Error).message);
  }
}

/**
 * Keep the answer given to a question, so a restart draws the card answered
 * (see the header). Only for a chat that is already cached: a resolution with
 * no transcript beside it would never be loaded or trimmed.
 */
export async function saveResolution(
  chatId: string,
  requestId: string,
  decision: 'approve' | 'deny',
  answers?: Record<string, string>,
): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction([CHATS, RESOLUTIONS], 'readwrite');
    const known = await promisify(tx.objectStore(CHATS).get(chatId));
    if (!known) return;
    const store = tx.objectStore(RESOLUTIONS);
    const held = (await promisify(store.get([chatId, requestId]))) as CachedResolution | undefined;
    const steps = held?.steps ?? [];
    const last = steps[steps.length - 1];
    if (
      last &&
      last.decision === decision &&
      JSON.stringify(last.answers) === JSON.stringify(answers)
    ) {
      return;
    }
    store.put({
      chatId,
      requestId,
      steps: [...steps, { decision, ...(answers !== undefined ? { answers } : {}) }],
    } satisfies CachedResolution);
  } catch (err) {
    console.warn('[patch] transcript cache resolution write failed:', (err as Error).message);
  }
}

/**
 * Record which track the cached events belong to. Called when the host says
 * what the active branch is; a LATER disagreement is what `dropTranscript`
 * exists for.
 */
export async function setBranch(chatId: string, branchId: string): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(CHATS, 'readwrite');
    const chats = tx.objectStore(CHATS);
    const existing = (await promisify(chats.get(chatId))) as CachedChatMeta | undefined;
    chats.put({
      chatId,
      branchId,
      openedAt: existing?.openedAt ?? Date.now(),
    } satisfies CachedChatMeta);
  } catch (err) {
    console.warn('[patch] transcript cache branch write failed:', (err as Error).message);
  }
}

/** Forget a chat entirely — its track was replaced, not extended. */
export async function dropTranscript(chatId: string): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction([EVENTS, CHATS, RESOLUTIONS], 'readwrite');
    tx.objectStore(EVENTS).delete(IDBKeyRange.bound([chatId, 0], [chatId, Infinity]));
    tx.objectStore(RESOLUTIONS).delete(IDBKeyRange.bound([chatId, ''], [chatId, '\uffff']));
    tx.objectStore(CHATS).delete(chatId);
  } catch (err) {
    console.warn('[patch] transcript cache drop failed:', (err as Error).message);
  }
}

/** Drop all but the `MAX_CACHED_CHATS` most recently opened chats. */
export async function trimCache(): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const metas = (await promisify(
      db.transaction(CHATS, 'readonly').objectStore(CHATS).getAll(),
    )) as CachedChatMeta[];
    if (metas.length <= MAX_CACHED_CHATS) return;
    const doomed = metas
      .sort((a, b) => b.openedAt - a.openedAt)
      .slice(MAX_CACHED_CHATS)
      .map((m) => m.chatId);
    for (const chatId of doomed) await dropTranscript(chatId);
  } catch (err) {
    console.warn('[patch] transcript cache trim failed:', (err as Error).message);
  }
}

/** Test seam: forget the memoised handle so a fresh DB can be opened. */
export function __resetCacheForTests(): void {
  dbPromise = null;
}
