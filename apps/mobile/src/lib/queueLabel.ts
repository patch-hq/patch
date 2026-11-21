// spec/04 ## Message queueing — a queued turn's chip says WHEN it goes in, not
// merely that it is waiting. `pos` is the 1-based place within the queued
// block as currently rendered, so promoting or removing an entry renumbers the
// block and the chip never contradicts the order on screen.

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

/**
 * What releases the entry at `index` of a queued block; one needing its own turn
 * holds back everything behind it. `steer` is whether the chat's provider takes
 * input into a running turn (spec/02 § Provider adapters); without it every
 * entry waits for the turn to end.
 */
export function queueRelease(
  block: ReadonlyArray<{ queuedOwnTurn?: boolean }>,
  index: number,
  steer: boolean,
): QueueRelease {
  if (!steer) return 'turn';
  for (let i = 0; i <= index; i++) if (block[i]?.queuedOwnTurn) return 'turn';
  return 'tool';
}

/**
 * The chat's turn is held on its account: a queued turn waits on that, not on
 * the agent. Read from the server's status alone (spec/05 § Chat status;
 * decision 35): a limit is said as the limit it is, and only an account that is
 * itself out of credit is called out of credit.
 */
export interface CreditPause {
  /** `limit`: a usage limit, waiting for a reset. `out`: the account is out of credit. `signed_out`: it needs signing in. */
  kind: 'limit' | 'out' | 'signed_out';
  /** Which pool: `session`, `week`, or another reason the server gave. Only for `limit`. */
  scope?: string;
  /** When the limit lifts, ms-epoch; null when nothing stated one or nothing resumes on its own. */
  resetsAt: number | null;
}

/** The pause a chat row is in, from its server status, or null. */
export function creditPause(
  row:
    | {
        chatStatus?: { state: string; reason?: string; resetsAt?: number } | undefined;
        limitNext?: 'resume_at_reset' | 'other_account' | 'switch_provider' | 'ask' | null;
      }
    | undefined,
): CreditPause | null {
  const st = row?.chatStatus;
  if (!st) return null;
  // A pause that waits for the user does not resume at any time (spec/10 §
  // Limits), so it is not given one to promise.
  const waitsForUser = row?.limitNext === 'switch_provider' || row?.limitNext === 'ask';
  const at = !waitsForUser && st.resetsAt !== undefined && st.resetsAt > 0 ? st.resetsAt : null;
  if (st.state === 'paused') {
    return { kind: 'limit', ...(st.reason ? { scope: st.reason } : {}), resetsAt: at };
  }
  if (st.state === 'waiting_for_sign_in') return { kind: 'signed_out', resetsAt: null };
  if (st.state === 'failed' && st.reason === 'out_of_credit')
    return { kind: 'out', resetsAt: null };
  if (st.state === 'failed' && (st.reason === 'limit_no_reset' || st.reason === 'limited')) {
    return { kind: 'limit', resetsAt: at };
  }
  return null;
}

/** The limit, named by its pool. */
function limitName(scope: string | undefined): string {
  if (scope === 'session') return 'session limit';
  if (scope === 'week') return 'weekly limit';
  return 'usage limit';
}

/**
 * What a pause is, in a few words: "session limit · resumes 20:30". A reset
 * that has passed is never shown as a promise: the turn is resuming.
 */
export function creditPauseText(pause: CreditPause, now: number = Date.now()): string {
  if (pause.kind === 'out') return 'out of credit';
  if (pause.kind === 'signed_out') return 'signed out';
  const name = limitName(pause.scope);
  if (pause.resetsAt === null) return name;
  return pause.resetsAt > now
    ? `${name} · resumes ${formatResume(pause.resetsAt, now)}`
    : `${name} · resuming…`;
}

/** `10:40`, or `Wed 17:58` when not today. */
export function formatResume(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (new Date(now).toDateString() === d.toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

export function queueChipLabel(
  pos: number,
  hostOnline = true,
  release?: QueueRelease,
  pause?: CreditPause | null,
  now: number = Date.now(),
): string {
  if (!hostOnline) return 'Host offline';
  if (pause) return `Paused · ${creditPauseText(pause, now)}`;
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
  now: number = Date.now(),
): string {
  if (!hostOnline) return 'Waiting for the host to come back online';
  if (pause?.kind === 'out') {
    return 'The account is out of credit; this runs once credit is added and the turn is continued';
  }
  if (pause?.kind === 'signed_out')
    return 'The account needs signing in again; this runs after that';
  if (pause) {
    return pause.resetsAt !== null && pause.resetsAt <= now
      ? `The ${limitName(pause.scope)} has reset; this runs once the paused turn resumes`
      : `The ${limitName(pause.scope)} was reached; this runs once it resets`;
  }
  if (release === 'tool') return 'Goes in when the agent finishes its current tool call';
  if (pos === 1) return 'Runs when the current turn finishes';
  const ahead = pos - 1;
  return `Runs after the current turn and ${ahead} message${ahead === 1 ? '' : 's'} ahead of it`;
}
