// Reading one track (branch) of a chat's own history log (spec/04 §
// Branching): parent-cut-plus-own-records. A track is its own records in full,
// plus its ancestors' records up to (and including) the seq each fork point
// hung off — mirroring exactly how Claude Code's own resumed transcript file
// physically carries a copy of everything before the resume point.

import {
  branchChain as sharedBranchChain,
  type LogRecord,
  type LoggedEvent,
  type TrackSegment,
} from '@patch/wire';
import type { ChatLog } from './chatLog.js';
import type { ChatMeta } from './meta.js';

export type { TrackSegment };

/**
 * The chain of (branch, upper-seq-bound) segments a track is made of, root
 * last (`branchChain` in `@patch/wire`, which the server's record uses too). A
 * chat written before branches existed is one root track.
 */
export function branchChain(meta: ChatMeta, targetBranchId: string): TrackSegment[] {
  return sharedBranchChain(
    meta.branches ?? [{ branchId: targetBranchId, parentBranchId: null, forkFromSeq: null }],
    targetBranchId,
  );
}

/**
 * Every logged event belonging to `targetBranchId`'s track, in seq order,
 * blob results already rehydrated (`ChatLog.readEvents`). `fromSeq` is
 * exclusive, as a history request's `after` is.
 */
export function readTrack(
  chatLog: Pick<ChatLog, 'readEvents'>,
  chatId: string,
  meta: ChatMeta,
  targetBranchId: string,
  fromSeq = -1,
): Array<{ record: LogRecord; event: LoggedEvent }> {
  const chain = branchChain(meta, targetBranchId);
  const bounds = new Map(chain.map((c) => [c.branchId, c.upperBound]));
  const out: Array<{ record: LogRecord; event: LoggedEvent }> = [];
  // `ChatLog.readEvents`'s `minSeq` is INCLUSIVE; `readTrack`'s `fromSeq` is
  // EXCLUSIVE, so it is one higher here.
  for (const entry of chatLog.readEvents(chatId, fromSeq + 1)) {
    const bound = bounds.get(entry.record.branchId);
    if (bound === undefined) continue;
    if (entry.record.seq > bound) continue;
    out.push(entry);
  }
  out.sort((a, b) => a.record.seq - b.record.seq);
  return lastMessageAtEachSeq(out);
}

/**
 * A message is one entry at its seq: a spoken reply is written when its first
 * word arrives and updated in place as it grows or is cut, so the log holds
 * several records at that seq and only the last is the message.
 */
function lastMessageAtEachSeq<T extends { event: LoggedEvent }>(entries: T[]): T[] {
  const lastAt = new Map<string, number>();
  entries.forEach(({ event }, i) => {
    if (event.type === 'chat.message') lastAt.set(`${event.seq}:${event.role}`, i);
  });
  return entries.filter(({ event }, i) =>
    event.type !== 'chat.message' ? true : lastAt.get(`${event.seq}:${event.role}`) === i,
  );
}

/**
 * Every record of ANY kind belonging to the track — not just `k:'event'`.
 * Needed for records the wire event stream never carried in the first place:
 * a failed turn's `turn.end` (spec/04 § History — a failed turn reads as a
 * system note, never a `chat.error`, which is not itself a logged event type
 * and so never appears via `readTrack`).
 */
export function readTrackRecords(
  chatLog: Pick<ChatLog, 'read'>,
  chatId: string,
  meta: ChatMeta,
  targetBranchId: string,
  fromSeq = -1,
): LogRecord[] {
  const chain = branchChain(meta, targetBranchId);
  const bounds = new Map(chain.map((c) => [c.branchId, c.upperBound]));
  const out: LogRecord[] = [];
  for (const record of chatLog.read(chatId, fromSeq + 1)) {
    if (record.seq < fromSeq + 1) continue;
    const bound = bounds.get(record.branchId);
    if (bound === undefined) continue;
    if (record.seq > bound) continue;
    out.push(record);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}
