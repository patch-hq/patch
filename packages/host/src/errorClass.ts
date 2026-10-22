// Every turn failure is either TRANSIENT (running the same turn again can
// succeed: a dropped connection, a 5xx, a busy server) or PERMANENT (it cannot:
// a refused credential, a malformed request, a prompt the model will not
// take). Only transient failures go on the retry ladder in `chatRunner.ts`; a
// permanent one settles `errored` at once with the real message, because three
// more identical failures only bury the reason.
//
// Classification is read from the error text, since that is all the SDK
// reliably gives us. A failure matching no rule is `unclassified`: it is still
// retried (bounded, as before) but reported as such so the log names the
// shape that needs a rule — nothing is silently assumed.

export type FailureKind = 'transient' | 'permanent';

export interface FailureClass {
  kind: FailureKind;
  /** The rule that matched, or `unclassified` when none did. */
  reason: string;
}

interface Rule {
  reason: string;
  kind: FailureKind;
  test: RegExp;
}

// Order matters: permanent rules come first so "400 ... overloaded" style
// compound messages are not retried, and specific rules precede generic ones.
const RULES: readonly Rule[] = [
  // --- permanent: the same request will be refused again ---
  {
    reason: 'invalid_request',
    kind: 'permanent',
    test: /invalid_request_error|api error: 400|\b400 bad request/i,
  },
  {
    reason: 'authentication',
    kind: 'permanent',
    test: /authentication_error|api error: 401|\b401 unauthorized|invalid (x-)?api[- ]key|invalid bearer token/i,
  },
  {
    reason: 'permission',
    kind: 'permanent',
    test: /permission_error|api error: 403|\b403 forbidden/i,
  },
  {
    reason: 'not_found',
    kind: 'permanent',
    test: /not_found_error|api error: 404|model.{0,40}(not found|does not exist)/i,
  },
  {
    reason: 'payload_too_large',
    kind: 'permanent',
    test: /request_too_large|api error: 413|prompt is too long|context (length|window).{0,30}exceed|exceeds the maximum/i,
  },
  { reason: 'unprocessable', kind: 'permanent', test: /api error: 422|unprocessable/i },
  {
    reason: 'content_policy',
    kind: 'permanent',
    test: /usage policy|content policy|violates .{0,30}policy/i,
  },
  {
    reason: 'local_io',
    kind: 'permanent',
    test: /\b(ENOENT|EACCES|EPERM|ENOSPC|EISDIR|ENOTDIR)\b/,
  },
  {
    reason: 'claude_missing',
    kind: 'permanent',
    test: /claude code (executable|native binary) not found|spawn claude ENOENT/i,
  },
  // The kernel OOM killer SIGKILLs the child (exit 137). Running the same turn
  // again re-grows the same memory, so it settles errored at once, not laddered.
  {
    reason: 'out_of_memory',
    kind: 'permanent',
    test: /exited with code 137\b|terminated by signal SIGKILL|out of memory|\bENOMEM\b|\bOOM\b/i,
  },
  // --- transient: the condition can clear on its own ---
  // Claude Code's own run died ("[session_crash] error_name=AbortError
  // api_error_status=none"). Before `server_error`, whose `api_error` test
  // would otherwise match the `api_error_status` field and misname it.
  { reason: 'session_crash', kind: 'transient', test: /\[session_crash\]/i },
  { reason: 'overloaded', kind: 'transient', test: /overloaded_error|api error: 529/i },
  {
    reason: 'rate_limited',
    kind: 'transient',
    test: /rate_limit_error|api error: 429|too many requests/i,
  },
  {
    reason: 'server_error',
    kind: 'transient',
    test: /api_error|api error: 5\d\d|\b50[0-4] (internal|bad gateway|service unavailable|gateway time)|internal server error|bad gateway|service unavailable|gateway timeout/i,
  },
  {
    reason: 'request_timeout',
    kind: 'transient',
    test: /api error: 408|api error: 409|request timed? ?out|timeout_error|\btimed out\b/i,
  },
  {
    reason: 'network',
    kind: 'transient',
    test: /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z_]+)\b|socket hang up|fetch failed|network error|connection (error|reset|closed|lost)|stream (terminated|closed|ended)|terminated$|premature close/i,
  },
  {
    reason: 'process_exit',
    kind: 'transient',
    test: /process exited with code|process terminated by signal/i,
  },
];

export function classifyFailure(message: string): FailureClass {
  for (const rule of RULES) {
    if (rule.test.test(message)) return { kind: rule.kind, reason: rule.reason };
  }
  return { kind: 'transient', reason: 'unclassified' };
}

/** Backoff for retry `attempt` (1-based): `base * 2^(attempt-1)`, capped. */
export function backoffMs(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), capMs);
}
