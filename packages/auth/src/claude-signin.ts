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
//
// The serif is the app's own Fraunces, subset to the few glyphs this page can
// show (the three titles, and the wordmark's italic p) and inlined, so the page
// matches the app's headings rather than the browser's default serif.
const FRAUNCES_ROMAN =
  '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';
const FRAUNCES_ITALIC =
  'd09GMgABAAAAAALUAA8AAAAABOgAAAJ8AAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGyAcKgZgP1NUQVR+ADQRCAqCBIF0ATYCJAMICwYABCAFgUoHIAwHG8oDII7DOIZ8YHIndPA8b/d57pv5ayowUEJd0i0ocHcriCEIE0hAAnurXZwdyWKQWIhN0mGggSY3nlCiYYDNWYBJM48P+OD6zrkgbGVB8N611x9FADM8eJGCoooGTNAB2gIABDAjSAgVGbMa3GP0UFyChrWuLZN/GMDgoB9ve8NaOcMDdZm4kQB94cWNuwFmMNzwtbtVgWmA6gEIgHbYMB7woSEIJhgABxqQQQ0bPmqiAPW3qEEUMq5f/9EiqHbVVeWiof1+YVnb1THCTRQFIHYsBwZDBltoIB7g0HRQ6CAmCEwHplUboAANcKAhUtfxATo6AgyvctpWIAAs0LAGBAWAzsgKMA72PVAoXfcJ6DDJdsJQ60lWk8Zv3hLYuGYN01ebdV+4Vmascz537pD7pHWXLj06Z75oQ+/Vu53WbnJ+R2p8Qw2vf0PT27dxyUfeFL55967du7dvi96+7vUT4+c+GD+/1Ks9xibt8X5/necUTx/1qsj0xkFj82arpUZWH8xMLr0Jqk5vcm50yvJuDVtqbn948YT5/o1jSzal5C3scji6vxqp1vfPu2gx1WrVoq/PJ4yRDow826o7l0T5FMr0vt1u2y+xneixpbJyxlDteRcAriOAwJ6bTd7drDP+m2jGzwE+XT5VCfA9eMKHtthWJ2224RsKIxQAAs8gaz8ChG+QnXhDVmah99wGKYCiYLlBzYS+NEQ3RWEBR0vAhQUECwKgsBEDDTNyYIIFwA4zynY9sNGg1Gg9DDZAL9WGG13RfNJHvQEm6qOdPgbop7/R6g3T12hD9THKKO0MM9QgE8RKkGC40ao6XX5Hg7YPra+Jw/q8tM05ri8BAA==';
const LOOPBACK_PAGE = (title: string, line: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="color-scheme" content="light dark"><title>${title} · Patch</title>` +
  `<style>` +
  `@font-face{font-family:PatchDisplay;font-style:normal;src:url(data:font/woff2;base64,${FRAUNCES_ROMAN}) format("woff2")}` +
  `@font-face{font-family:PatchMark;font-style:italic;src:url(data:font/woff2;base64,${FRAUNCES_ITALIC}) format("woff2")}` +
  `:root{--bg:#f2f0ea;--card:#fff;--ink:#1b1813;--ink-3:#645c50;--line:#ddd6c6}` +
  `@media(prefers-color-scheme:dark){:root{--bg:#191817;--card:#2d2b28;--ink:#efede9;--ink-3:#928d84;--line:#4a463f}}` +
  `body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}` +
  `main{width:min(420px,88vw);box-sizing:border-box;padding:40px 32px;background:var(--card);border:1px solid var(--line);border-radius:16px;text-align:center}` +
  `svg{display:block;margin:0 auto 20px}` +
  `h1{font:500 30px/1.15 PatchDisplay,Georgia,serif;margin:0 0 10px}` +
  `p{margin:0;color:var(--ink-3)}` +
  `</style>` +
  `<body><main>` +
  `<svg viewBox="0 0 64 64" width="48" height="48" role="img" aria-label="Patch"><circle cx="32" cy="32" r="32" fill="#3a5e2c"/>` +
  `<text x="32" y="46" text-anchor="middle" font-family="PatchMark,Georgia,serif" font-style="italic" font-weight="500" font-size="44" fill="#ebe7dc">p</text></svg>` +
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
