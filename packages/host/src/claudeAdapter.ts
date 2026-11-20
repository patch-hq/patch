// The Claude Code adapter's host-side pieces that the chat core reaches only
// through its traits (`harnesses.ts`, spec/02 § Provider adapters): making the
// chat's own session file ready for a turn, and recognising the Claude Agent
// SDK's own words for a lost session and a refused credential.

import type { Logger } from 'pino';
import { createClaudeSessionStore } from './claudeSessionStore.js';
import { defaultClaudeProjectsRoot } from './history.js';

/**
 * Claude runs under the chat's own config dir (`<chatDir>/claude`, spec/04 §
 * History). Before a turn resumes a session, its one conversation file is made
 * ready there (a session from before per-chat config dirs is migrated in).
 * Patch never edits the file or reads it for display.
 */
export async function prepareClaudeSession(ctx: {
  chatId: string;
  folder: string;
  chatDir: string;
  sessionId: string | undefined;
  sessionStoreRoot: string | undefined;
  logger: Logger;
}): Promise<void> {
  if (ctx.sessionId === undefined) return;
  await createClaudeSessionStore({
    chatId: ctx.chatId,
    folder: ctx.folder,
    chatDir: ctx.chatDir,
    claudeProjectsRoot: ctx.sessionStoreRoot ?? defaultClaudeProjectsRoot(),
    logger: ctx.logger,
  }).prepare(ctx.sessionId);
}

/**
 * Words any agent may use for a session it cannot resume. Every adapter counts
 * these; the Claude SDK has phrasings of its own on top
 * (`isClaudeSessionInvalidError`).
 */
export function soundsLikeLostSession(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'SessionNotFoundError' || err.name === 'SessionExpiredError') return true;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('session not found') ||
    msg.includes('session expired') ||
    msg.includes('invalid session') ||
    msg.includes('unknown session id') ||
    msg.includes('no such session')
  );
}

/**
 * Best-effort detection of "the resumed Claude Code session no longer exists
 * or has expired". The SDK doesn't ship a typed error class for this — we
 * pattern-match on the message text the SDK / underlying transport surfaces.
 * Spec/04 line 46: surface a `claude_session_invalid` code so the surface
 * can offer a fresh-start prompt. NO FALLBACK: if it's not session-invalid,
 * it's classified as a generic `sdk_error`.
 */
export function isClaudeSessionInvalidError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (soundsLikeLostSession(err)) return true;
  const msg = err.message.toLowerCase();
  return (
    // The real Claude Agent SDK rejects a bad `--resume` argument with these
    // phrasings (e.g. a stale non-UUID id, or one no longer on disk). Treat it
    // as a stale session: clear the chat's session so the next turn starts fresh.
    msg.includes('--resume requires a valid session') ||
    (msg.includes('is not a uuid') && msg.includes('session title')) ||
    msg.includes('does not match any session') ||
    // The real Claude Agent SDK / CLI surfaces a resume to a session whose
    // transcript no longer exists on disk as "No conversation found with
    // session ID: <uuid>". This is a lost session, not a generic SDK fault —
    // clear the chat's session so the next input starts a fresh session rather
    // than re-attempting the dead resume forever (spec/04 line 46, NO
    // FALLBACK to a silently-contextless run, but recoverable on next turn).
    msg.includes('no conversation found')
  );
}

/**
 * Detection of "Anthropic refused the credential we handed the SDK". The
 * pre-query gate only knows whether a token is present and locally unexpired —
 * a revoked one, or one whose stored expiry is a lie, passes the gate and is
 * then rejected on every single turn. Pattern-matched on the message text like
 * the session check above, because the SDK has no typed error for it; the real
 * phrasing is `Failed to authenticate. API Error: 401
 * {"error":{"type":"authentication_error",…}}`.
 *
 * A bare 401 is NOT enough — an HTTP 401 the agent hit inside its own tool call
 * says nothing about this host's Claude credential — so the status only counts
 * alongside an auth-specific word.
 */
export function isClaudeCredentialRejectedMessage(message: string): boolean {
  const msg = message.toLowerCase();
  if (
    msg.includes('authentication_error') ||
    msg.includes('failed to authenticate') ||
    msg.includes('oauth access token is invalid') ||
    msg.includes('invalid bearer token')
  ) {
    return true;
  }
  return msg.includes('api error: 401') && (msg.includes('oauth') || msg.includes('bearer token'));
}
