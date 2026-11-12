// Signing in to Claude without a terminal (spec/10-auth.md § Signing in to
// Claude from a surface).
//
// A Claude account in Patch is a `claude setup-token` token: a year-long,
// inference-only OAuth access token. Getting one used to need the Claude Code
// CLI on some machine — run `claude setup-token`, copy what it printed, paste it
// into Settings. A computer with nothing installed had no way to produce one.
//
// This is the same authorization `claude setup-token` performs, with the same
// client, scope, redirect and lifetime, so what it yields is the same token the
// paste flow stores: the person signs in on claude.ai in their own browser, the
// page there shows a code, and they paste that code back into Patch. The PKCE
// verifier never leaves the server that started the sign-in.

import { createHash, randomBytes } from 'node:crypto';
import { CLAUDE_OAUTH_CLIENT_ID } from './claude-oauth.js';

/** Where the person signs in (the address `claude setup-token` opens). */
export const CLAUDE_SIGNIN_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
/** The page that shows the person the code to paste back. */
export const CLAUDE_SIGNIN_REDIRECT_URL = 'https://platform.claude.com/oauth/code/callback';
/** Where the code is exchanged for the token. */
export const CLAUDE_SIGNIN_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/** Inference only, like `claude setup-token`: no profile, no API-key minting. */
export const CLAUDE_SIGNIN_SCOPE = 'user:inference';
/** One year, the lifetime `claude setup-token` asks for. */
export const CLAUDE_SIGNIN_TOKEN_SECONDS = 31_536_000;

const b64url = (buf: Buffer): string => buf.toString('base64url');

export interface ClaudeSignInStart {
  /** The page to open in the person's browser. */
  url: string;
  /** Kept by the server until the code comes back; never sent to a surface. */
  verifier: string;
  /** Echoed back by claude.ai with the code; a code with another state is refused. */
  state: string;
}

/** A fresh sign-in: the address to open and the secrets that finish it. */
export function startClaudeSignIn(random: (n: number) => Buffer = randomBytes): ClaudeSignInStart {
  const verifier = b64url(random(32));
  const state = b64url(random(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const url = new URL(CLAUDE_SIGNIN_AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLAUDE_OAUTH_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', CLAUDE_SIGNIN_REDIRECT_URL);
  url.searchParams.set('scope', CLAUDE_SIGNIN_SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return { url: url.toString(), verifier, state };
}

/**
 * What the claude.ai page shows is `<code>#<state>`. People copy it whole, or
 * only the part before the `#`, or with a stray space or newline; all of those
 * are the same answer. A state that is there and different is not: it belongs
 * to another sign-in.
 */
export function parseClaudeSignInCode(
  pasted: string,
  expectedState: string,
): { code: string } | { error: string } {
  const trimmed = pasted.replace(/\s+/g, '');
  if (trimmed === '') return { error: 'Paste the code claude.ai showed you.' };
  const [code, state] = trimmed.split('#', 2) as [string, string | undefined];
  if (code === '') return { error: 'That is not a sign-in code.' };
  if (state !== undefined && state !== '' && state !== expectedState) {
    return { error: 'That code belongs to a different sign-in. Start again.' };
  }
  return { code };
}

export interface ExchangeClaudeCodeOptions {
  fetchImpl?: typeof fetch;
  tokenUrl?: string;
}

/**
 * Exchange the pasted code for the token. A refusal is said in Anthropic's own
 * words: an expired or already-used code is something the person can act on.
 */
export async function exchangeClaudeSignInCode(
  args: { code: string; verifier: string; state: string },
  opts: ExchangeClaudeCodeOptions = {},
): Promise<{ accessToken: string; expiresAt: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(opts.tokenUrl ?? CLAUDE_SIGNIN_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: args.code,
        redirect_uri: CLAUDE_SIGNIN_REDIRECT_URL,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        code_verifier: args.verifier,
        state: args.state,
        expires_in: CLAUDE_SIGNIN_TOKEN_SECONDS,
      }),
    });
  } catch (e) {
    throw new ClaudeSignInError('unreachable', `Could not reach Claude: ${(e as Error).message}`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let reason = text;
    try {
      const body = JSON.parse(text) as { error_description?: string; error?: string };
      reason = body.error_description ?? body.error ?? text;
    } catch {
      // Not JSON: the raw text is the reason.
    }
    throw new ClaudeSignInError(
      res.status === 400 || res.status === 401 ? 'rejected' : 'unreachable',
      `Claude refused the code (HTTP ${res.status}${reason ? `: ${reason}` : ''}). Sign in again for a new one.`,
    );
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ClaudeSignInError(
      'unreachable',
      'Claude answered the sign-in with something unreadable.',
    );
  }
  const accessToken = body['access_token'];
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new ClaudeSignInError('unreachable', 'Claude accepted the code but sent no token.');
  }
  const seconds =
    typeof body['expires_in'] === 'number' ? body['expires_in'] : CLAUDE_SIGNIN_TOKEN_SECONDS;
  return { accessToken, expiresAt: Date.now() + seconds * 1000 };
}

export class ClaudeSignInError extends Error {
  constructor(
    readonly kind: 'rejected' | 'unreachable',
    message: string,
  ) {
    super(message);
    this.name = 'ClaudeSignInError';
  }
}
