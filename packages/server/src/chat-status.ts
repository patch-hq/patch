// A chat's status, decided by the server alone (spec/12 § Chat status).
//
// Hosts report facts on `chat.state` (what the chat is doing, how its last turn
// ended, a limit it met); the server sees each host come and go, and holds the
// messages it keeps for an offline host. From those it derives one status per
// chat and sends it on every `chat.state` as `chatStatus`. Surfaces display it
// and never work it out.

import type { ChatStateEvent, ChatStatusInfo, ChatStatusState } from '@patch/wire';

type Target = Omit<ChatStatusInfo, 'since'> & { state: ChatStatusState };

const SIGNED_OUT_CODES = new Set(['claude_oauth_missing', 'chatgpt_login_required']);
const SESSION_GONE_CODES = new Set(['claude_session_missing', 'claude_session_invalid']);

/** What a host's `chat.state` says the chat's status is. */
export function statusFromHostState(event: ChatStateEvent): Target {
  if (event.limitBlock) {
    return {
      state: 'paused',
      reason: event.limitBlock.scope,
      ...(event.limitBlock.resetsAt !== undefined ? { resetsAt: event.limitBlock.resetsAt } : {}),
      ...(event.limitBlock.accountId !== undefined
        ? { accountId: event.limitBlock.accountId }
        : {}),
    };
  }
  switch (event.activity) {
    case 'running':
      return { state: 'running' };
    case 'awaiting-permission':
      return { state: 'waiting_for_user' };
    case 'errored': {
      const err = event.lastError ?? null;
      if (err && SIGNED_OUT_CODES.has(err.code))
        return { state: 'waiting_for_sign_in', reason: err.code };
      // The server's own stand-in while the host's link is down.
      if (err?.code === 'daemon_unavailable') return { state: 'host_offline' };
      if (err && SESSION_GONE_CODES.has(err.code)) {
        return { state: 'failed', reason: 'session_gone', message: err.message };
      }
      return {
        state: 'failed',
        reason: err?.code ?? 'unknown',
        ...(err ? { message: err.message } : {}),
      };
    }
    case 'idle':
    default:
      // A turn parked until a stated limit lifts.
      if (typeof event.rateLimitResumingAt === 'number') {
        return {
          state: 'paused',
          reason: event.resumeKind ?? 'rate_limit',
          resetsAt: event.rateLimitResumingAt,
        };
      }
      // A question the agent itself declared (`patch_ask_human`) blocks on the
      // user just as a permission request does.
      if (event.statusKind === 'question' && event.statusDeclared === true) {
        return { state: 'waiting_for_user' };
      }
      return { state: 'idle' };
  }
}

/** The changes spec/12 § Allowed transitions names. A status may always stay what it is. */
const ALLOWED: Record<ChatStatusState, readonly ChatStatusState[]> = {
  idle: ['running', 'queued_offline', 'waiting_for_user'],
  running: [
    'waiting_for_user',
    'idle',
    'paused',
    'waiting_for_sign_in',
    'failed',
    'host_restarting',
    'host_offline',
  ],
  waiting_for_user: ['running', 'idle', 'host_restarting', 'host_offline'],
  queued_offline: ['running', 'idle'],
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
  interrupted: ['running', 'queued_offline', 'idle'],
  paused: ['running', 'idle'],
  waiting_for_sign_in: ['running', 'idle'],
  failed: ['running', 'queued_offline', 'idle'],
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
  target: Target,
  now: number,
): ChatStatusInfo {
  const since = prev && prev.state === target.state ? prev.since : now;
  return { ...target, since };
}
