// A chat's status, decided by the server alone (spec/12 § Chat status).
//
// Hosts report facts: a turn started, a turn ended with its outcome, a question
// raised or resolved, and on `chat.state` the facts only a host knows (a turn
// cut off by its machine going down, a limit a turn met, a retry it has
// scheduled, a question the agent declared). The server sees each host come and
// go, and holds the messages it keeps for an offline host. This module keeps
// those facts per chat and derives one status from them; a host never sends a
// status or an activity of its own.

import type {
  ChatActivity,
  ChatStateEvent,
  ChatStatusInfo,
  ChatStatusState,
  TurnOutcome,
} from '@patch/wire';

export type StatusTarget = Omit<ChatStatusInfo, 'since'> & { state: ChatStatusState };

/** The question tool: a question stays open after its turn, an approval does not. */
const QUESTION_TOOL = 'AskUserQuestion';

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
  /** The host says a turn met a limit and is parked until it lifts. */
  limit: { reason: string; resetsAt?: number; accountId?: string } | null;
  /** The host has scheduled another attempt at a turn that met a transient error. */
  retrying: boolean;
  /** Turns the host holds queued to run once the current one ends. */
  hostQueued: number;
  /** The agent declared it is blocked on the user (`patch_ask_human`). */
  declaredQuestion: boolean;
  /** The server holds a message for this chat's offline host. */
  held: boolean;
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
    retrying: false,
    hostQueued: 0,
    declaredQuestion: false,
    held: false,
    heldExpired: null,
    away: null,
  };
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
export function deriveStatus(facts: ChatStatusFacts, owed = false): StatusTarget {
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
  if (facts.held) return { state: 'queued_offline' };
  if (owed || facts.retrying || facts.hostQueued > 0) return { state: 'running' };
  if (facts.limit) {
    return {
      state: 'paused',
      reason: facts.limit.reason,
      ...(facts.limit.resetsAt !== undefined ? { resetsAt: facts.limit.resetsAt } : {}),
      ...(facts.limit.accountId !== undefined ? { accountId: facts.limit.accountId } : {}),
    };
  }
  if (facts.interrupted || facts.lastEnd?.outcome === 'interrupted')
    return { state: 'interrupted' };
  if (facts.declaredQuestion) return { state: 'waiting_for_user' };
  if (facts.lastEnd?.outcome === 'failed') {
    const err = facts.lastEnd.error;
    if (err && SIGNED_OUT_CODES.has(err.code)) {
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
export function factsFromHostState(prev: ChatStatusFacts, event: ChatStateEvent): ChatStatusFacts {
  let limit: ChatStatusFacts['limit'] = null;
  if (event.limitBlock) {
    limit = {
      reason: event.limitBlock.scope,
      ...(event.limitBlock.resetsAt !== undefined ? { resetsAt: event.limitBlock.resetsAt } : {}),
      ...(event.limitBlock.accountId !== undefined
        ? { accountId: event.limitBlock.accountId }
        : {}),
    };
  } else if (typeof event.rateLimitResumingAt === 'number') {
    limit = { reason: event.resumeKind ?? 'rate_limit', resetsAt: event.rateLimitResumingAt };
  }
  return {
    ...prev,
    interrupted: event.interrupted === true,
    limit,
    retrying: event.turnRetrying === true,
    hostQueued: event.queuedTurns ?? 0,
    declaredQuestion: event.statusKind === 'question' && event.statusDeclared === true,
    // The host is speaking for the chat again: it has reattached.
    away: null,
  };
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
    held: false,
    heldExpired: null,
    away: null,
  };
}

export function factsOnTurnEnded(
  prev: ChatStatusFacts,
  turnId: string,
  outcome: TurnOutcome,
  error: { code: string; message: string } | undefined,
): ChatStatusFacts {
  return {
    ...prev,
    openTurns: prev.openTurns.filter((t) => t !== turnId),
    lastEnd: { outcome, ...(error ? { error } : {}) },
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
  queued_offline: ['running'],
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
  paused: ['running', 'idle'],
  waiting_for_sign_in: ['running', 'idle'],
  failed: ['running', 'queued_offline'],
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
  if (facts.held || facts.heldExpired !== null)
    return facts.heldExpired !== null ? 'errored' : 'idle';
  if (owed || facts.hostQueued > 0) return 'running';
  if (facts.retrying) return 'errored';
  if (facts.limit || facts.interrupted || facts.lastEnd?.outcome === 'interrupted') return 'idle';
  if (facts.lastEnd?.outcome === 'failed') return 'errored';
  return 'idle';
}
