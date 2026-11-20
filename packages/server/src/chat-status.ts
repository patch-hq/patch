// A chat's status, decided by the server alone (spec/12 § Chat status).
//
// Hosts report facts: a turn started, a turn ended with its outcome, a question
// raised or resolved, and on `chat.state` the facts only a host knows (a turn
// cut off by its machine going down, a limit a turn met, a retry it has
// scheduled, a question the agent declared). The server sees each host come and
// go, and holds the messages it keeps for an offline host. This module keeps
// those facts per chat and derives one status from them; a host never sends a
// status or an activity of its own.
//
// Accounts report their state (spec/10 § Account states). Whether a chat whose
// turn met a limit is paused until a reset, waiting for sign-in or out of
// credit is read from the state of the account the turn ran on, not from
// anything the host concluded: the host says only that the turn ended on a
// limit, with the provider's words and reset (`chat.turn_ended.limit`).

import type {
  AccountState,
  ChatActivity,
  ChatStateEvent,
  ChatStatusInfo,
  ChatStatusState,
  TurnLimit,
  TurnOutcome,
} from '@patch/wire';

export type StatusTarget = Omit<ChatStatusInfo, 'since'> & { state: ChatStatusState };

/** The question tool: a question stays open after its turn, an approval does not. */
const QUESTION_TOOL = 'AskUserQuestion';

/** Turn failures that are a missing sign-in, for a chat whose account the server cannot name. */
const SIGNED_OUT_CODES = new Set(['claude_oauth_missing', 'chatgpt_login_required']);
const SESSION_GONE_CODES = new Set(['claude_session_missing', 'claude_session_invalid']);

/** What the server knows about one chat, from which its status is derived. */
export interface ChatStatusFacts {
  /** Turns started and not yet ended, by `turnId` (a side branch runs its own). */
  openTurns: string[];
  /**
   * Requests raised and not yet resolved, kept until the host resolves each;
   * `question` marks the question tool.
   */
  openRequests: { id: string; question: boolean }[];
  /** How the latest turn ended. Cleared when the next one starts. */
  lastEnd: { outcome: TurnOutcome; error?: { code: string; message: string } } | null;
  /** The host says the last turn was cut off and its process is gone. */
  interrupted: boolean;
  /**
   * A turn met a limit and is owed until it lifts: from `chat.turn_ended.limit`
   * (a host that says `limitFacts`), or from `chat.state.limitBlock` (an older
   * host). Cleared when the next turn starts, or when the host no longer holds
   * the owed turn.
   */
  limit: { reason: string; resetsAt?: number; accountId?: string; message?: string } | null;
  /** The account the chat's latest turn ran on (`chat.state.account`). */
  accountId: string | null;
  /** The host has scheduled another attempt at a turn that met a transient error. */
  retrying: boolean;
  /** Turns the host holds queued to run once the current one ends. */
  hostQueued: number;
  /** The agent declared it is blocked on the user (`patch_ask_human`). */
  declaredQuestion: boolean;
  /**
   * Messages the server held for this chat's offline host, by `localId`, until
   * the host takes each (`chat.input_ack`), refuses it (`chat.error` naming
   * it), a turn starts, or it expires.
   */
  held: string[];
  /** A held message expired undelivered: the words of the failure. */
  heldExpired: string | null;
  /**
   * The chat was working when its host went: announced (`restarting`) or not
   * (`offline`). Cleared when the host speaks for the chat again.
   */
  away: 'restarting' | 'offline' | null;
}

export function emptyFacts(): ChatStatusFacts {
  return {
    openTurns: [],
    openRequests: [],
    lastEnd: null,
    interrupted: false,
    limit: null,
    accountId: null,
    retrying: false,
    hostQueued: 0,
    declaredQuestion: false,
    held: [],
    heldExpired: null,
    away: null,
  };
}

/** The state of an account by id, as the server holds it; undefined for one it does not know. */
export type AccountStateLookup = (accountId: string) => AccountState | undefined;

const noAccounts: AccountStateLookup = () => undefined;

/**
 * The status of a chat whose turn is owed on a limit, from the state of the
 * account it ran on (spec/12 § Limits and sign-in). Signed out asks for sign-in
 * and out of credit stops; neither is retried. A limit the account confirms, or
 * one the server cannot check, is a pause until the reset. Where no reset is
 * known at all the limit is treated as out (spec/10 § Limits). An account with
 * credit again leaves the owed turn paused until it runs or the user continues it.
 */
function limitStatus(
  limit: NonNullable<ChatStatusFacts['limit']>,
  account: AccountState | undefined,
): StatusTarget {
  const accountId = limit.accountId;
  const about = accountId !== undefined ? { accountId } : {};
  const paused = (resetsAt: number | undefined): StatusTarget => ({
    state: 'paused',
    reason: limit.reason,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(limit.message !== undefined ? { message: limit.message } : {}),
    ...about,
  });
  const outOfCredit = (message: string | undefined): StatusTarget => ({
    state: 'failed',
    reason: 'out_of_credit',
    ...(message !== undefined ? { message } : {}),
    ...about,
  });
  switch (account?.state) {
    case 'signed_out':
      return { state: 'waiting_for_sign_in', reason: 'signed_out', ...about };
    case 'out':
      return outOfCredit(account.message);
    case 'broken':
      return { state: 'failed', reason: 'account_broken', message: account.message, ...about };
    case 'ready':
    case 'near_limit':
      return paused(limit.resetsAt);
    case 'limited':
    case undefined: {
      const resetsAt = (account?.state === 'limited' ? account.until : undefined) ?? limit.resetsAt;
      return resetsAt !== undefined ? paused(resetsAt) : outOfCredit(limit.message);
    }
  }
}

/** True when the chat has a turn in flight or a request waiting on the user. */
export function isMidTurn(facts: ChatStatusFacts): boolean {
  return facts.openTurns.length > 0 || facts.openRequests.length > 0;
}

/**
 * The one status the facts give. `owed` is work the server itself holds for
 * the chat (a queued message it is about to release), which keeps a chat
 * running between turns rather than flickering idle.
 */
export function deriveStatus(
  facts: ChatStatusFacts,
  owed = false,
  accounts: AccountStateLookup = noAccounts,
): StatusTarget {
  if (facts.away !== null) {
    return { state: facts.away === 'restarting' ? 'host_restarting' : 'host_offline' };
  }
  // A request is open until its host says it was answered, cancelled or
  // expired; the host resolves every one, a stopped turn's included.
  if (facts.openRequests.length > 0) return { state: 'waiting_for_user' };
  if (facts.openTurns.length > 0) return { state: 'running' };
  if (facts.heldExpired !== null) {
    return { state: 'failed', reason: 'held_message_expired', message: facts.heldExpired };
  }
  if (facts.held.length > 0) return { state: 'queued_offline' };
  if (owed || facts.retrying || facts.hostQueued > 0) return { state: 'running' };
  if (facts.limit) {
    const accountId = facts.limit.accountId ?? facts.accountId ?? undefined;
    return limitStatus(
      { ...facts.limit, ...(accountId !== undefined ? { accountId } : {}) },
      accountId !== undefined ? accounts(accountId) : undefined,
    );
  }
  if (facts.interrupted || facts.lastEnd?.outcome === 'interrupted')
    return { state: 'interrupted' };
  if (facts.declaredQuestion) return { state: 'waiting_for_user' };
  if (facts.lastEnd?.outcome === 'failed') {
    const err = facts.lastEnd.error;
    // A failed turn on an account that is signed out or out of credit stops and
    // asks, whatever the failure's own code said (spec/10 § Account states).
    const accountId = facts.accountId ?? undefined;
    const account = accountId !== undefined ? accounts(accountId) : undefined;
    if (account?.state === 'signed_out') {
      return {
        state: 'waiting_for_sign_in',
        reason: 'signed_out',
        accountId: accountId!,
        ...(err ? { message: err.message } : {}),
      };
    }
    if (account?.state === 'out') {
      return {
        state: 'failed',
        reason: 'out_of_credit',
        message: account.message,
        accountId: accountId!,
      };
    }
    if (err && SIGNED_OUT_CODES.has(err.code)) {
      // Signed in again since: nothing is owed, so the chat is at rest.
      if (account !== undefined) return { state: 'idle' };
      return { state: 'waiting_for_sign_in', reason: err.code, message: err.message };
    }
    if (err && SESSION_GONE_CODES.has(err.code)) {
      return { state: 'failed', reason: 'session_gone', message: err.message };
    }
    return {
      state: 'failed',
      reason: err?.code ?? 'unknown',
      ...(err ? { message: err.message } : {}),
    };
  }
  return { state: 'idle' };
}

/**
 * The facts a host's `chat.state` carries. Each frame states them whole, so
 * an absent field is the host saying the fact no longer holds.
 */
export function factsFromHostState(
  prev: ChatStatusFacts,
  event: ChatStateEvent,
  hostLimitFacts = false,
): ChatStatusFacts {
  const accountId = event.account?.id ?? prev.accountId;
  if (hostLimitFacts) {
    // The limit comes from the turn's end; this frame says only whether the
    // host still holds the owed turn. An overload backoff is a transient retry,
    // not a limit (spec/12 § Transient errors).
    const limitHeld = event.limitNext !== null && event.limitNext !== undefined;
    const overloadRetry =
      typeof event.rateLimitResumingAt === 'number' && event.resumeKind === 'overloaded';
    return {
      ...prev,
      ...limitLifted(prev, limitHeld ? prev.limit : null),
      accountId,
      interrupted: event.interrupted === true,
      retrying: event.turnRetrying === true || overloadRetry,
      hostQueued: event.queuedTurns ?? 0,
      declaredQuestion: event.statusKind === 'question' && event.statusDeclared === true,
      away: null,
    };
  }
  let limit: ChatStatusFacts['limit'] = null;
  if (event.limitBlock) {
    limit = {
      reason: event.limitBlock.scope,
      ...(event.limitBlock.resetsAt !== undefined ? { resetsAt: event.limitBlock.resetsAt } : {}),
      ...(event.limitBlock.accountId !== undefined
        ? { accountId: event.limitBlock.accountId }
        : {}),
      ...(event.limitBlock.raw !== undefined ? { message: event.limitBlock.raw } : {}),
    };
  } else if (typeof event.rateLimitResumingAt === 'number') {
    limit = { reason: event.resumeKind ?? 'rate_limit', resetsAt: event.rateLimitResumingAt };
  }
  return {
    ...prev,
    ...limitLifted(prev, limit),
    accountId,
    interrupted: event.interrupted === true,
    retrying: event.turnRetrying === true,
    hostQueued: event.queuedTurns ?? 0,
    declaredQuestion: event.statusKind === 'question' && event.statusDeclared === true,
    // The host is speaking for the chat again: it has reattached.
    away: null,
  };
}

/**
 * The limit a chat is held on now. When the host stops holding an owed turn
 * without a new one starting (the user switched provider or dropped it), the
 * turn that met the limit is not a failure left to read: nothing is owed, and
 * the chat is at rest (spec/12 § Allowed transitions).
 */
function limitLifted(
  prev: ChatStatusFacts,
  limit: ChatStatusFacts['limit'],
): Pick<ChatStatusFacts, 'limit' | 'lastEnd'> {
  if (prev.limit !== null && limit === null && prev.lastEnd?.outcome === 'failed') {
    return { limit, lastEnd: null };
  }
  return { limit, lastEnd: prev.lastEnd };
}

/** A turn began: what the last one left behind no longer applies. */
export function factsOnTurnStarted(prev: ChatStatusFacts, turnId: string): ChatStatusFacts {
  return {
    ...prev,
    openTurns: prev.openTurns.includes(turnId) ? prev.openTurns : [...prev.openTurns, turnId],
    lastEnd: null,
    interrupted: false,
    limit: null,
    retrying: false,
    held: [],
    heldExpired: null,
    away: null,
  };
}

/**
 * The host took a held message (or refused it): it is not waiting any more.
 * Whatever became of it is said by the facts that follow: a turn starting, the
 * running turn it was steered into, the turns the host owes, or nothing at all
 * for a duplicate the host had already taken.
 */
export function factsOnHeldResolved(prev: ChatStatusFacts, localId: string): ChatStatusFacts {
  // `*` is a held message recorded before messages were told apart.
  const held = prev.held.filter((id) => id !== localId && id !== '*');
  return held.length === prev.held.length ? prev : { ...prev, held };
}

/** Facts read back from disk, a held flag from before held messages had ids included. */
export function restoredFacts(
  saved: Partial<Omit<ChatStatusFacts, 'held'>> & { held?: unknown },
): ChatStatusFacts {
  const held = Array.isArray(saved.held)
    ? saved.held.filter((id): id is string => typeof id === 'string')
    : saved.held === true
      ? ['*']
      : [];
  return { ...emptyFacts(), ...saved, held };
}

export function factsOnTurnEnded(
  prev: ChatStatusFacts,
  turnId: string,
  outcome: TurnOutcome,
  error: { code: string; message: string } | undefined,
  limit?: TurnLimit,
): ChatStatusFacts {
  return {
    ...prev,
    openTurns: prev.openTurns.filter((t) => t !== turnId),
    lastEnd: { outcome, ...(error ? { error } : {}) },
    ...(limit !== undefined
      ? {
          // A host sends this only for a turn it holds owed; it stands until
          // the next turn starts or a frame says the host no longer holds it.
          limit: {
            reason: limit.scope,
            ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}),
            ...(limit.accountId !== undefined ? { accountId: limit.accountId } : {}),
            message: limit.message,
          },
        }
      : {}),
    away: null,
  };
}

export function factsOnRequestRaised(
  prev: ChatStatusFacts,
  requestId: string,
  tool: string,
): ChatStatusFacts {
  if (prev.openRequests.some((r) => r.id === requestId)) return { ...prev, away: null };
  return {
    ...prev,
    openRequests: [...prev.openRequests, { id: requestId, question: tool === QUESTION_TOOL }],
    away: null,
  };
}

export function factsOnRequestResolved(prev: ChatStatusFacts, requestId: string): ChatStatusFacts {
  return { ...prev, openRequests: prev.openRequests.filter((r) => r.id !== requestId) };
}

/** The changes spec/12 § Allowed transitions names. A status may always stay what it is. */
const ALLOWED: Record<ChatStatusState, readonly ChatStatusState[]> = {
  // A question the agent declares as its turn ends can land after the end itself.
  idle: ['running', 'queued_offline', 'waiting_for_user'],
  running: [
    'waiting_for_user',
    'idle',
    'paused',
    'waiting_for_sign_in',
    'failed',
    'interrupted',
    'host_restarting',
    'host_offline',
  ],
  waiting_for_user: ['running', 'idle', 'host_restarting', 'host_offline'],
  // The host took the message: a turn starts, or (a duplicate, or one steered
  // into a turn that already ended) the chat is as its other facts say; or it
  // refused it.
  queued_offline: ['running', 'idle', 'interrupted', 'failed'],
  host_restarting: [
    'host_offline',
    'running',
    'waiting_for_user',
    'interrupted',
    'idle',
    'paused',
    'waiting_for_sign_in',
    'failed',
  ],
  host_offline: [
    'running',
    'waiting_for_user',
    'interrupted',
    'idle',
    'paused',
    'waiting_for_sign_in',
    'failed',
  ],
  interrupted: ['running', 'queued_offline'],
  // The account a paused or stopped chat ran on can change state under it:
  // signed out, out of credit, signed in again, credit back.
  paused: ['running', 'idle', 'waiting_for_sign_in', 'failed'],
  waiting_for_sign_in: ['running', 'idle', 'paused', 'failed'],
  failed: ['running', 'queued_offline', 'paused', 'waiting_for_sign_in'],
};

export function isAllowedTransition(from: string, to: ChatStatusState): boolean {
  return from === to || (ALLOWED[from as ChatStatusState]?.includes(to) ?? false);
}

/**
 * The next status. `since` moves only when the state changes; the details
 * (reason, reset time) always follow the latest fact.
 */
export function nextStatus(
  prev: ChatStatusInfo | null,
  target: StatusTarget,
  now: number,
): ChatStatusInfo {
  const since = prev && prev.state === target.state ? prev.since : now;
  return { ...target, since };
}

/**
 * The server's status said the old way, for surfaces and server readers that
 * predate `chatStatus`. Worked out from the same facts as the status, never
 * taken from anything a host concluded. It keeps the old meaning: `running` and
 * `awaiting-permission` only while a turn is in flight, so a chat parked on a question after its
 * turn ended still takes a message as an idle one did. Work the server's queue owes reads as
 * `running`; the queue itself asks without it, to know when to release.
 */
export function legacyActivity(facts: ChatStatusFacts, owed = false): ChatActivity {
  if (facts.away === 'offline') return 'errored';
  const turnOpen = facts.openTurns.length > 0;
  if (turnOpen) return facts.openRequests.length > 0 ? 'awaiting-permission' : 'running';
  if (facts.openRequests.some((r) => !r.question)) return 'awaiting-permission';
  if (facts.heldExpired !== null) return 'errored';
  if (facts.held.length > 0) return 'idle';
  if (owed || facts.hostQueued > 0) return 'running';
  if (facts.retrying) return 'errored';
  if (facts.limit || facts.interrupted || facts.lastEnd?.outcome === 'interrupted') return 'idle';
  if (facts.lastEnd?.outcome === 'failed') return 'errored';
  return 'idle';
}
