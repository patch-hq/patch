import { describe, expect, it } from 'vitest';
import {
  CHATGPT_CLIENT_ID,
  ChatGPTSignInError,
  chatgptLoginFromTokens,
  exchangeChatGPTDeviceCode,
  pollChatGPTDeviceCode,
  requestChatGPTDeviceCode,
} from '../src/index.js';

const reply = (status: number, body: unknown): typeof fetch =>
  (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as never;

const jwt = (claims: object): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

describe('ChatGPT device sign-in', () => {
  it('asks OpenAI for a code with Codex’s client', async () => {
    let seen: { url: string; body: string } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, body: String(init.body) };
      return new Response(
        JSON.stringify({ device_auth_id: 'd1', user_code: 'ABCD-1234', interval: '7' }),
      );
    }) as never;
    const code = await requestChatGPTDeviceCode({ fetchImpl });
    expect(code).toEqual({ deviceAuthId: 'd1', userCode: 'ABCD-1234', intervalSeconds: 7 });
    expect(seen?.url).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode');
    expect(JSON.parse(seen!.body)).toEqual({ client_id: CHATGPT_CLIENT_ID });
  });

  it('says unreachable, not rejected, when OpenAI cannot be reached', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as never;
    await expect(requestChatGPTDeviceCode({ fetchImpl })).rejects.toMatchObject({
      kind: 'unreachable',
    });
  });

  it('reads 403 and 404 as not approved yet, and 200 as approved', async () => {
    const code = { deviceAuthId: 'd1', userCode: 'X' };
    expect(await pollChatGPTDeviceCode(code, { fetchImpl: reply(403, '') })).toEqual({
      status: 'pending',
    });
    expect(await pollChatGPTDeviceCode(code, { fetchImpl: reply(404, '') })).toEqual({
      status: 'pending',
    });
    expect(
      await pollChatGPTDeviceCode(code, {
        fetchImpl: reply(200, { authorization_code: 'a', code_verifier: 'v' }),
      }),
    ).toEqual({ status: 'approved', authorizationCode: 'a', codeVerifier: 'v' });
    await expect(pollChatGPTDeviceCode(code, { fetchImpl: reply(500, '') })).rejects.toBeInstanceOf(
      ChatGPTSignInError,
    );
  });

  it('exchanges the approved code for tokens, and names a refusal in OpenAI’s words', async () => {
    const tokens = await exchangeChatGPTDeviceCode(
      { authorizationCode: 'a', codeVerifier: 'v' },
      { fetchImpl: reply(200, { id_token: 'i', access_token: 'a', refresh_token: 'r' }) },
    );
    expect(tokens).toEqual({ idToken: 'i', accessToken: 'a', refreshToken: 'r' });
    await expect(
      exchangeChatGPTDeviceCode(
        { authorizationCode: 'a', codeVerifier: 'v' },
        { fetchImpl: reply(400, { error_description: 'code used' }) },
      ),
    ).rejects.toMatchObject({ kind: 'rejected', message: expect.stringContaining('code used') });
  });

  it('writes the auth.json Codex reads, with the account as identity', () => {
    const idToken = jwt({
      email: 'me@example.com',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-9' },
    });
    const login = chatgptLoginFromTokens(
      { idToken, accessToken: 'at', refreshToken: 'rt' },
      () => new Date('2026-11-17T00:00:00Z'),
    );
    expect(login.identity).toBe('acct-9');
    expect(login.email).toBe('me@example.com');
    expect(JSON.parse(login.authJson)).toEqual({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { id_token: idToken, access_token: 'at', refresh_token: 'rt', account_id: 'acct-9' },
      last_refresh: '2026-11-17T00:00:00.000Z',
    });
  });

  it('refuses a login with no ChatGPT account', () => {
    expect(() =>
      chatgptLoginFromTokens({ idToken: jwt({}), accessToken: 'a', refreshToken: 'r' }),
    ).toThrow(ChatGPTSignInError);
  });
});
