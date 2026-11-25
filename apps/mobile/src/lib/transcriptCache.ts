// A chat's transcript, kept on this phone (spec/15 § Instant open, spec/12 §
// Cold start). MMKV — the same store the credential and the chat list use.
//
// Replay is cheap now that tool bodies stay in the blob store and the answer
// arrives as a few frames instead of thousands. This is the last piece: a
// chat you have already opened should not be downloaded again just because
// the app was killed. Opening one paints from here synchronously — before a
// frame is drawn, let alone before the socket answers — and the ask that
// follows is only for what is newer than the last seq held.
//
// The SERVER stays the record. This is a cache, never a source of truth:
//   - Only DURABLE events are kept — the ones carrying a seq, exactly what a
//     replay would re-send. Deltas and state frames are never stored.
//   - Keyed by branch. A fork, an edit or a branch switch makes the cached
//     track the WRONG track, and the chat is dropped whole and refetched
//     rather than merged into something plausible.
//   - Unreadable content is reported and dropped, never silently treated as
//     an empty chat: this runs on the open path, and a launch-blocking throw
//     over a disposable mirror would be far worse than the refetch it saves.
//
// One exception to "only events with a seq": a question's ANSWER. The host
// sends `chat.permission_response` without a seq, so it can never be kept as
// an event — yet the `chat.permission_request` it settles was. Hold only the
// request and a restart redraws the card open and blank while the agent
// already has the answer, and the replay for seq > the highest held never
// re-sends the settled pair. So answers are kept beside the events and
// re-applied after them.
//
// Bounded twice — events per chat, and chats — so a year of use cannot grow
// without limit on a phone. And pruned to the chat list each time it is
// refreshed (`pruneTranscripts`), so a chat deleted, archived or hidden
// elsewhere does not stay on the phone until the bound pushes it out.

import { store } from './credential';
import { useUiStore } from '../stores/uiStore';

const KEY_PREFIX = 'patch.transcript.v1.';
const INDEX_KEY = 'patch.transcript.index.v1';
/**
 * The highest seq held per chat, beside the blob. `heldCursor` runs for every
 * held chat on each connect; reading this one number instead of parsing the
 * whole transcript keeps launch from decoding hundreds of blobs on the JS thread.
 */
const CURSOR_PREFIX = 'patch.transcript.cursor.v1.';
/**
 * Events that arrived since the chat's blob was last written, kept beside it.
 *
 * A held transcript runs to megabytes (3000 events of a tool-heavy chat is
 * ~2.5 MB). Rewriting it for every coalesced batch meant parsing, sorting and
 * re-serialising the whole thing on the JS thread every 750 ms for every chat
 * that was moving — on a phone, hundreds of milliseconds per chat, so a few
 * busy agents kept the thread at 100% and the app froze. New events go to this
 * small tail instead; the blob is rewritten only when the tail grows past
 * `TAIL_COMPACT_AT`, or when something else rewrites it anyway.
 */
const TAIL_PREFIX = 'patch.transcript.tail.v1.';
/** Tail length at which it is folded into the blob. */
export const TAIL_COMPACT_AT = 250;
/** Most recent events kept per chat — well past a tall screen's worth. */
export const MAX_CACHED_EVENTS = 3000;
/**
 * How many chats' transcripts to keep, least-recently-opened dropped first.
 * Every chat in the roster is meant to read offline (spec/12 § Offline
 * reading), so this is a safety ceiling on a phone's storage, not the working
 * set.
 */
export const MAX_CACHED_CHATS = 500;
/** Per-chat sync marks an earlier build kept; nothing reads them now. */
const LEGACY_SYNCED_KEY = 'patch.transcript.synced.v1';
/** Live events trickle in; coalesce before rewriting a chat's blob. */
const FLUSH_MS = 750;

/** One decision taken on a question, in the order it was taken. */
export interface CachedResolutionStep {
  decision: 'approve' | 'deny';
  answers?: Record<string, string>;
}

interface CachedChat {
  branchId: string | null;
  events: unknown[];
  /** requestId -> the decisions taken on it. */
  resolutions: Record<string, CachedResolutionStep[]>;
}

/** chatId -> epoch ms last opened. */
type CacheIndex = Record<string, number>;

const pending = new Map<string, unknown[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function key(chatId: string): string {
  return `${KEY_PREFIX}${chatId}`;
}

function cursorKey(chatId: string): string {
  return `${CURSOR_PREFIX}${chatId}`;
}

function tailKey(chatId: string): string {
  return `${TAIL_PREFIX}${chatId}`;
}

/** Every key held for one chat. */
function deleteChatKeys(chatId: string): void {
  store().delete(key(chatId));
  store().delete(cursorKey(chatId));
  store().delete(tailKey(chatId));
}

/**
 * The events waiting beside the blob, oldest first. Null when it was
 * unreadable: reported, and the chat dropped.
 */
function readTail(chatId: string): unknown[] | null {
  const raw = store().getString(tailKey(chatId));
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('cached transcript tail is not a list');
    return parsed;
  } catch (e) {
    // The tail alone cannot be trusted to sit on top of the blob any more:
    // drop the chat whole, as with an unreadable blob, so it is refetched.
    deleteChatKeys(chatId);
    useUiStore.getState().pushError(`transcript cache unreadable: ${(e as Error).message}`);
    return null;
  }
}

/** `incoming` merged over `held` by seq — a re-delivery overwrites — oldest first. */
function mergeBySeq(held: unknown[], incoming: unknown[]): unknown[] {
  const bySeq = new Map<number, unknown>();
  for (const event of held) {
    const seq = durableSeq(event);
    if (seq !== null) bySeq.set(seq, event);
  }
  for (const event of incoming) {
    const seq = durableSeq(event);
    if (seq !== null) bySeq.set(seq, event);
  }
  return [...bySeq.entries()].sort(([a], [b]) => a - b).map(([, e]) => e);
}

function trim(events: unknown[]): unknown[] {
  return events.length > MAX_CACHED_EVENTS ? events.slice(-MAX_CACHED_EVENTS) : events;
}

function durableSeq(event: unknown): number | null {
  if (typeof event !== 'object' || event === null) return null;
  const e = event as { seq?: unknown; chatId?: unknown };
  if (typeof e.chatId !== 'string') return null;
  // A negative seq is an optimistic local echo the host has not persisted;
  // caching one would resurrect a message that may never have been sent.
  return typeof e.seq === 'number' && Number.isInteger(e.seq) && e.seq >= 0 ? e.seq : null;
}

/** Highest durable seq in `events`, or -1. A `chat.error` never moves it. */
function cursorOf(events: unknown[]): number {
  return events.reduce<number>((max, e) => {
    // A failed turn's error reaches every surface, so it can be the only event
    // held for a chat never replayed; it must not move the cursor.
    if ((e as { type?: unknown }).type === 'chat.error') return max;
    const seq = durableSeq(e);
    return seq !== null && seq > max ? seq : max;
  }, -1);
}

function readIndex(): CacheIndex {
  const raw = store().getString(INDEX_KEY);
  if (raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as CacheIndex) : {};
  } catch {
    store().delete(INDEX_KEY);
    return {};
  }
}

/** The blob alone, without the tail beside it. */
function readBlob(chatId: string): CachedChat | null {
  const raw = store().getString(key(chatId));
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Blobs written before answers were kept have no `resolutions`: upgrade
    // them in place rather than reporting a healthy transcript as unreadable.
    if (typeof parsed === 'object' && parsed !== null && !('resolutions' in parsed)) {
      (parsed as CachedChat).resolutions = {};
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as CachedChat).events) ||
      typeof (parsed as CachedChat).resolutions !== 'object' ||
      (parsed as CachedChat).resolutions === null
    ) {
      throw new Error('cached transcript is not a transcript');
    }
    return parsed as CachedChat;
  } catch (e) {
    deleteChatKeys(chatId);
    useUiStore.getState().pushError(`transcript cache unreadable: ${(e as Error).message}`);
    return null;
  }
}

/** What is held for a chat: the blob with the tail folded over it. */
function readChat(chatId: string): CachedChat | null {
  const blob = readBlob(chatId);
  if (blob === null) {
    // A tail never outlives its blob (every delete takes both); one left over
    // from an interrupted write has nothing to sit on and is dropped.
    store().delete(tailKey(chatId));
    return null;
  }
  const tail = readTail(chatId);
  if (tail === null) return null;
  if (tail.length === 0) return blob;
  return { ...blob, events: trim(mergeBySeq(blob.events, tail)) };
}

/** Write a chat's whole blob, folding the tail into it. */
function writeBlob(chatId: string, chat: CachedChat): void {
  const events = trim(chat.events);
  store().set(cursorKey(chatId), String(cursorOf(events)));
  store().set(key(chatId), JSON.stringify({ ...chat, events } satisfies CachedChat));
  store().delete(tailKey(chatId));
}

/**
 * What this phone already holds for a chat, oldest first — or null. Returns
 * synchronously, which is the whole point: the transcript is on screen in
 * the first frame rather than after a round trip.
 */
export function loadTranscript(chatId: string): CachedChat | null {
  const held = readChat(chatId);
  if (held === null) return null;
  const index = readIndex();
  index[chatId] = Date.now();
  store().set(INDEX_KEY, JSON.stringify(index));
  return held;
}

/**
 * Merge `events` into what is held, newest `MAX_CACHED_EVENTS` kept.
 *
 * Into the tail while it is short — reading and writing a few hundred events,
 * not the whole transcript — and into the blob once it has grown (see
 * `TAIL_PREFIX`). A chat with no blob yet gets one straight away.
 */
function writeMerged(chatId: string, incoming: unknown[]): void {
  if (store().getString(key(chatId)) === undefined) {
    store().delete(tailKey(chatId));
    writeBlob(chatId, { branchId: null, events: mergeBySeq([], incoming), resolutions: {} });
    return;
  }
  const held = readTail(chatId);
  if (held === null) return;
  const tail = mergeBySeq(held, incoming);
  if (tail.length >= TAIL_COMPACT_AT) {
    const chat = readChat(chatId);
    if (chat === null) return;
    writeBlob(chatId, { ...chat, events: mergeBySeq(chat.events, tail) });
    return;
  }
  store().set(tailKey(chatId), JSON.stringify(tail));
  const cursor = Math.max(heldCursor(chatId), cursorOf(tail));
  store().set(cursorKey(chatId), String(cursor));
}

function flush(): void {
  flushTimer = null;
  const batch = [...pending.entries()];
  pending.clear();
  try {
    for (const [chatId, events] of batch) writeMerged(chatId, events);
    const index = readIndex();
    const now = Date.now();
    // A chat that is receiving live events is in use: refresh its recency, or
    // the sweep below could evict the blob it has just been written to and
    // leave a tail of events that a later open takes for the whole transcript.
    for (const [chatId] of batch) index[chatId] = now;
    // Bound the number of chats held, least-recently-opened first.
    const ordered = Object.entries(index).sort(([, a], [, b]) => b - a);
    for (const [chatId] of ordered.slice(MAX_CACHED_CHATS)) {
      deleteChatKeys(chatId);
      delete index[chatId];
    }
    store().set(INDEX_KEY, JSON.stringify(index));
  } catch (e) {
    useUiStore.getState().pushError(`transcript cache write failed: ${(e as Error).message}`);
  }
}

/**
 * Keep these events for `chatId`. Coalesced: a streaming reply lands a run of
 * events a few milliseconds apart, and rewriting the chat's blob for each one
 * would cost more than the cache saves.
 */
export function saveEvents(chatId: string, events: unknown[]): void {
  const keepable = events.filter((e) => durableSeq(e) !== null);
  if (keepable.length === 0) return;
  const held = pending.get(chatId);
  if (held) held.push(...keepable);
  else pending.set(chatId, keepable);
  if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_MS);
}

/** Record which track the held events belong to. */
export function setBranch(chatId: string, branchId: string): void {
  const held = readChat(chatId);
  if (held === null || held.branchId === branchId) return;
  writeBlob(chatId, { ...held, branchId });
}

/**
 * Keep the answer given to a question, so a restart draws the card answered
 * (see the header). Only for a chat already held: an answer with no
 * transcript beside it would never be loaded or trimmed.
 */
export function saveResolution(
  chatId: string,
  requestId: string,
  decision: 'approve' | 'deny',
  answers?: Record<string, string>,
): void {
  try {
    // The request may still be waiting in the coalescing buffer.
    if (pending.has(chatId)) flush();
    const held = readChat(chatId);
    if (held === null) return;
    const steps = held.resolutions[requestId] ?? [];
    const last = steps[steps.length - 1];
    if (
      last &&
      last.decision === decision &&
      JSON.stringify(last.answers) === JSON.stringify(answers)
    ) {
      return;
    }
    held.resolutions[requestId] = [
      ...steps,
      { decision, ...(answers !== undefined ? { answers } : {}) },
    ];
    writeBlob(chatId, held);
  } catch (e) {
    useUiStore.getState().pushError(`transcript cache write failed: ${(e as Error).message}`);
  }
}

/** Forget a chat entirely — its track was replaced, not extended. */
export function dropTranscript(chatId: string): void {
  pending.delete(chatId);
  deleteChatKeys(chatId);
  const index = readIndex();
  delete index[chatId];
  store().set(INDEX_KEY, JSON.stringify(index));
}

/** Test seam: drop anything waiting to be written. */
export function __resetPendingForTests(): void {
  pending.clear();
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
}

/** The chats this phone holds a transcript for. Reads only the index, never a transcript. */
export function heldChatIds(): Set<string> {
  return new Set(Object.keys(readIndex()));
}

/** The highest seq held for a chat, or -1 when nothing is. Reads only; no recency bump. */
export function heldCursor(chatId: string): number {
  const mark = store().getString(cursorKey(chatId));
  if (mark !== undefined) {
    const n = Number(mark);
    if (Number.isInteger(n)) return n;
    store().delete(cursorKey(chatId));
  }
  // A blob written before cursors were kept: derive it once and keep it.
  const held = readChat(chatId);
  if (held === null) return -1;
  const cursor = cursorOf(held.events);
  store().set(cursorKey(chatId), String(cursor));
  return cursor;
}

/**
 * Forget the transcripts of chats that are not in `keep`: the chat list the
 * server has just sent, plus whatever the phone has open. The roster lists the
 * account's active chats, so a chat deleted, archived or hidden elsewhere
 * leaves the phone at the next refresh; opening it again fetches it from the
 * server.
 */
export function pruneTranscripts(keep: Set<string>): void {
  try {
    const index = readIndex();
    for (const chatId of Object.keys(index)) {
      if (keep.has(chatId)) continue;
      pending.delete(chatId);
      deleteChatKeys(chatId);
      delete index[chatId];
    }
    store().set(INDEX_KEY, JSON.stringify(index));
    store().delete(LEGACY_SYNCED_KEY);
  } catch (e) {
    useUiStore.getState().pushError(`transcript cache prune failed: ${(e as Error).message}`);
  }
}
