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
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

export interface ClaudeSignInStartOptions {
  /**
   * A `http://localhost:<port>/callback` address on the machine the person's
   * browser is on. With it claude.ai sends the code straight back and nothing
   * is pasted; without it the code is shown on a page and pasted by hand.
   */
  loopbackRedirect?: string;
  /** A state chosen in advance, for a loopback listener that must know it first. */
  state?: string;
}

/** A fresh sign-in: the address to open and the secrets that finish it. */
export function startClaudeSignIn(
  random: (n: number) => Buffer = randomBytes,
  opts: ClaudeSignInStartOptions = {},
): ClaudeSignInStart {
  const verifier = b64url(random(32));
  const state = opts.state ?? b64url(random(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const url = new URL(CLAUDE_SIGNIN_AUTHORIZE_URL);
  // `code=true` asks claude.ai to show the code on a page; a loopback sign-in
  // is an ordinary authorization-code redirect and must not ask for it.
  if (!opts.loopbackRedirect) url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLAUDE_OAUTH_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', opts.loopbackRedirect ?? CLAUDE_SIGNIN_REDIRECT_URL);
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
  args: { code: string; verifier: string; state: string; redirectUri?: string },
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
        redirect_uri: args.redirectUri ?? CLAUDE_SIGNIN_REDIRECT_URL,
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

export interface ClaudeLoopbackResult {
  /** The code claude.ai sent back, or why the return was not usable. */
  outcome: { code: string } | { error: string };
}

export interface ClaudeLoopbackListener {
  /** The address to hand to {@link startClaudeSignIn} as `loopbackRedirect`. */
  redirectUri: string;
  /** Settles once, when claude.ai's redirect arrives or the listener is closed. */
  result: Promise<ClaudeLoopbackResult['outcome']>;
  close: () => void;
}

// The page the browser lands on after claude.ai approves: the app's own
// palette, card and wordmark, light and dark, so it reads as Patch and not as a
// bare browser page. Self-contained: nothing is fetched from this tiny server.
const LOOPBACK_PAGE = (title: string, line: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="color-scheme" content="light dark"><title>${title} · Patch</title>` +
  `<style>` +
  `:root{--bg:#f2f0ea;--card:#fff;--ink:#1b1813;--ink-3:#645c50;--line:#ddd6c6}` +
  `@media(prefers-color-scheme:dark){:root{--bg:#191817;--card:#2d2b28;--ink:#efede9;--ink-3:#928d84;--line:#4a463f}}` +
  `body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}` +
  `main{width:min(420px,88vw);box-sizing:border-box;padding:40px 32px;background:var(--card);border:1px solid var(--line);border-radius:16px;text-align:center}` +
  `svg{display:block;margin:0 auto 20px}` +
  `h1{font:600 30px/1.15 Georgia,serif;margin:0 0 10px}` +
  `p{margin:0;color:var(--ink-3)}` +
  `</style>` +
  `<body><main>` +
  `<svg viewBox="0 0 64 64" width="48" height="48" role="img" aria-label="Patch"><circle cx="32" cy="32" r="32" fill="#3a5e2c"/>` +
  `<text x="32" y="46" text-anchor="middle" font-family="Georgia,serif" font-style="italic" font-weight="500" font-size="44" fill="#ebe7dc">p</text></svg>` +
  `<h1>${title}</h1><p>${line}</p></main>`;

/**
 * Listen on this machine for claude.ai's redirect, the way Claude Code's own
 * login does. Bound to 127.0.0.1 on a free port, it answers exactly one request
 * to `/callback` carrying this sign-in's `state`; any other request (a stray
 * probe, another sign-in's state) is refused and the wait goes on.
 */
export async function listenForClaudeSignIn(
  state: string,
  host = '127.0.0.1',
): Promise<ClaudeLoopbackListener> {
  let settle!: (o: ClaudeLoopbackResult['outcome']) => void;
  const result = new Promise<ClaudeLoopbackResult['outcome']>((r) => (settle = r));
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
      res.writeHead(404, headers).end(LOOPBACK_PAGE('Not found', 'This is not a Patch sign-in.'));
      return;
    }
    const code = url.searchParams.get('code');
    const failure = url.searchParams.get('error_description') ?? url.searchParams.get('error');
    if (!code) {
      res
        .writeHead(400, headers)
        .end(LOOPBACK_PAGE('Sign-in failed', 'Claude did not approve the sign-in.'));
      settle({ error: `Claude did not approve the sign-in${failure ? `: ${failure}` : ''}.` });
    } else {
      res
        .writeHead(200, headers)
        .end(LOOPBACK_PAGE('Signed in', 'You can close this tab and return to Patch.'));
      settle({ code });
    }
    close();
  });
  const close = (): void => {
    server.close();
    server.closeAllConnections();
    settle({ error: 'The sign-in was cancelled.' });
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return { redirectUri: `http://localhost:${port}/callback`, result, close };
}
