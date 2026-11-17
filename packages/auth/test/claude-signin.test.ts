import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_SIGNIN_REDIRECT_URL,
  CLAUDE_SIGNIN_TOKEN_SECONDS,
  ClaudeSignInError,
  exchangeClaudeSignInCode,
  parseClaudeSignInCode,
  startClaudeSignIn,
} from '../src/index.js';

let next = 0;
const counting = (n: number): Buffer => Buffer.alloc(n, ++next);

describe('startClaudeSignIn', () => {
  it('asks for exactly what `claude setup-token` asks for', () => {
    const s = startClaudeSignIn(counting);
    const url = new URL(s.url);
    expect(url.origin + url.pathname).toBe('https://claude.com/cai/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(CLAUDE_OAUTH_CLIENT_ID);
    expect(url.searchParams.get('scope')).toBe('user:inference');
    expect(url.searchParams.get('redirect_uri')).toBe(CLAUDE_SIGNIN_REDIRECT_URL);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(s.state);
    const challenge = createHash('sha256').update(s.verifier).digest('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(s.url).not.toContain(s.verifier);
  });

  it('makes a new verifier and state every time', () => {
    const a = startClaudeSignIn();
    const b = startClaudeSignIn();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });
});

describe('parseClaudeSignInCode', () => {
  it('takes the code with or without its state, and ignores whitespace', () => {
    expect(parseClaudeSignInCode('abc#st', 'st')).toEqual({ code: 'abc' });
    expect(parseClaudeSignInCode(' abc\n', 'st')).toEqual({ code: 'abc' });
    expect(parseClaudeSignInCode('abc#', 'st')).toEqual({ code: 'abc' });
  });
  it('refuses a code from another sign-in, and an empty one', () => {
    expect(parseClaudeSignInCode('abc#other', 'st')).toHaveProperty('error');
    expect(parseClaudeSignInCode('   ', 'st')).toHaveProperty('error');
    expect(parseClaudeSignInCode('#st', 'st')).toHaveProperty('error');
  });
});

describe('exchangeClaudeSignInCode', () => {
  it('posts the PKCE exchange and returns the token', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ access_token: 'sk-ant-oat01-x', expires_in: 100 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const out = await exchangeClaudeSignInCode(
      { code: 'c', verifier: 'v', state: 's' },
      { fetchImpl },
    );
    expect(out.accessToken).toBe('sk-ant-oat01-x');
    expect(sent).toMatchObject({
      grant_type: 'authorization_code',
      code: 'c',
      code_verifier: 'v',
      state: 's',
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      redirect_uri: CLAUDE_SIGNIN_REDIRECT_URL,
      expires_in: CLAUDE_SIGNIN_TOKEN_SECONDS,
    });
  });

  it('says a refused code is refused, in Claude’s words', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Code expired' }), {
        status: 400,
      })) as unknown as typeof fetch;
    const err = await exchangeClaudeSignInCode(
      { code: 'c', verifier: 'v', state: 's' },
      { fetchImpl },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeSignInError);
    expect((err as ClaudeSignInError).kind).toBe('rejected');
    expect((err as Error).message).toContain('Code expired');
  });

  it('tells "could not reach" apart from "refused"', async () => {
    const fetchImpl = (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;
    const err = (await exchangeClaudeSignInCode(
      { code: 'c', verifier: 'v', state: 's' },
      { fetchImpl },
    ).catch((e: unknown) => e)) as ClaudeSignInError;
    expect(err.kind).toBe('unreachable');
  });

  it('refuses a 200 with no token', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    await expect(
      exchangeClaudeSignInCode({ code: 'c', verifier: 'v', state: 's' }, { fetchImpl }),
    ).rejects.toThrow(/no token/);
  });
});
