// spec/04 ## Message queueing — a queued turn's chip says WHEN it goes in, not
// merely that it is waiting. `pos` is the 1-based place within the queued
// block as currently rendered, so promoting or removing an entry renumbers the
// block and the chip never contradicts the order on screen.

import { formatReset } from './usage.js';

function ordinal(n: number): string {
  // 11/12/13 take "th" despite ending 1/2/3 — and so do 111/112/113.
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return `${n}th`;
  const last = n % 10;
  if (last === 1) return `${n}st`;
  if (last === 2) return `${n}nd`;
  if (last === 3) return `${n}rd`;
  return `${n}th`;
}

// While the host is offline nothing is running ahead of the message: it is
// waiting on the host, not on a turn, so the chip says so (spec/12 § Host-offline UX).
//
// `release` says which event lets the message in: `tool` — the agent's next
// tool call finishing (a plain message is handed over at that boundary) — or
// `turn` — the whole turn ending (a fork, job, hook or goal turn, or anything
// queued behind one). Omitted, the chip carries position only.
export type QueueRelease = 'tool' | 'turn';

/** What releases the entry at `index` of a queued block; one needing its own turn holds back everything behind it. */
export function queueRelease(
  block: ReadonlyArray<{ queuedOwnTurn?: boolean }>,
  index: number,
): QueueRelease {
  for (let i = 0; i <= index; i++) if (block[i]?.queuedOwnTurn) return 'turn';
  return 'tool';
}

/**
 * The chat is out of credit: nothing queued behind its parked turn runs until
 * the limit lifts, so "Queued · next tool call" would promise a delivery that
 * is not coming. `resetsAt` is the stated return, ms-epoch, or null when the
 * limit named none.
 */
export interface CreditPause {
  resetsAt: number | null;
}

/** The credit pause a chat row is in, or null. A transient overload is not a lack of credit. */
export function creditPause(row: {
  rateLimitResumingAt?: number | null;
  resumeKind?: 'rate_limit' | 'overloaded' | null;
  limitBlock?: { resetsAt?: number } | null;
}): CreditPause | null {
  if (row.resumeKind === 'overloaded' && !row.limitBlock) return null;
  if (!row.rateLimitResumingAt && !row.limitBlock) return null;
  const at = row.limitBlock?.resetsAt ?? row.rateLimitResumingAt ?? null;
  return { resetsAt: at !== null && at > 0 ? at : null };
}

export function queueChipLabel(
  pos: number,
  hostOnline = true,
  release?: QueueRelease,
  pause?: CreditPause | null,
  /** "Mac host" — which host it is waiting for. */
  host = 'Host',
): string {
  if (!hostOnline) return `${host} offline`;
  if (pause) {
    const base = 'Paused · out of credit';
    return pause.resetsAt === null ? base : `${base} · resumes ${formatReset(pause.resetsAt)}`;
  }
  const base = pos === 1 ? 'Queued' : `${ordinal(pos)} in queue`;
  if (release === undefined) return base;
  return `${base} · ${release === 'tool' ? 'next tool call' : 'end of turn'}`;
}

/** The event that releases this turn — the half of the mental model a bare position can't carry. */
export function queueChipTitle(
  pos: number,
  hostOnline = true,
  release?: QueueRelease,
  pause?: CreditPause | null,
  host = 'the host',
): string {
  if (!hostOnline) return `Waiting for ${host}`;
  if (pause) return 'Every account is out of credit; this runs once the limit resets';
  if (release === 'tool') return 'Goes in when the agent finishes its current tool call';
  if (pos === 1) return 'Runs when the current turn finishes';
  const ahead = pos - 1;
  return `Runs after the current turn and ${ahead} message${ahead === 1 ? '' : 's'} ahead of it`;
}
