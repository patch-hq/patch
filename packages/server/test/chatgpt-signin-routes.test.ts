// Signing in to ChatGPT from a surface (spec/10 § Signing in): the server asks
// OpenAI for a device code, shows it, polls for approval and stores the login.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatGPTSignInError, generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

const jwt = (accountId: string, email: string): string =>
  `h.${Buffer.from(
    JSON.stringify({ email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  ).toString('base64url')}.s`;

type Poll = () => Promise<
  { status: 'pending' } | { status: 'approved'; authorizationCode: string; codeVerifier: string }
>;

describe('ChatGPT sign-in routes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-chatgpt-signin-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function makeApp(poll: Poll, account = 'acct-1') {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(4));
    const data = mkdtempSync(join(dir, 'data-'));
    const registry = Registry.load(data);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-d', surfaceKind: 'desktop', label: 'd', issuedAt: 1 });
    const token = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-d',
      surfaceKind: 'desktop',
      label: 'd',
    });
    let who = account;
    const built = await buildAll({
      logger: false,
      registry,
      dataDir: data,
      hostLink: new InProcessHostLink(),
      chatgptDevice: {
        request: async () => ({ deviceAuthId: 'dev-1', userCode: 'ABCD-1234', intervalSeconds: 0 }),
        poll,
        exchange: async () => ({
          idToken: jwt(who, `${who}@example.com`),
          accessToken: 'at',
          refreshToken: 'rt',
        }),
      },
      jobsWatch: false,
      gcalSubscriptions: false,
    });
    const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, auth = true) =>
      built.app.inject({
        method,
        url,
        headers: auth ? { authorization: `Bearer ${token}` } : {},
        ...(payload === undefined ? {} : { payload }),
      });
    return { built, call, as: (a: string) => void (who = a) };
  }
  const approved = async () => ({
    status: 'approved' as const,
    authorizationCode: 'a',
    codeVerifier: 'v',
  });

  it('shows a code, waits for approval, then adds the account without leaking tokens', async () => {
    let ok = false;
    const { built, call } = await makeApp(async () => (ok ? approved() : { status: 'pending' }));
    try {
      const start = await call('POST', '/api/accounts/codex/signin', {});
      expect(start.statusCode, start.body).toBe(200);
      const { signInId, userCode, url } = start.json() as {
        signInId: string;
        userCode: string;
        url: string;
      };
      expect(userCode).toBe('ABCD-1234');
      expect(url).toBe('https://auth.openai.com/codex/device');

      const waiting = await call('GET', `/api/accounts/codex/signin/${signInId}`);
      expect(waiting.json()).toMatchObject({ status: 'pending' });

      ok = true;
      const done = await call('GET', `/api/accounts/codex/signin/${signInId}`);
      expect(done.json()).toMatchObject({ status: 'complete' });

      const state = await call('GET', '/api/settings/shared');
      expect(state.statusCode).toBe(200);
      expect(state.body).toContain('acct-1@example.com');
      expect(state.body).not.toContain('"rt"');
      expect(state.body).not.toContain('refresh_token');
    } finally {
      await built.app.close();
    }
  });

  it('refuses a second sign-in as an account that is already connected', async () => {
    const { built, call } = await makeApp(approved);
    try {
      for (const expected of ['complete', 'failed']) {
        const { signInId } = (await call('POST', '/api/accounts/codex/signin', {})).json() as {
          signInId: string;
        };
        const res = await call('GET', `/api/accounts/codex/signin/${signInId}`);
        expect(res.json()).toMatchObject({ status: expected });
        if (expected === 'failed') {
          expect(res.json()).toMatchObject({ code: 'duplicate_account' });
        }
      }
    } finally {
      await built.app.close();
    }
  });

  it('signs a row in again, keeping its id and label', async () => {
    const { built, call } = await makeApp(approved);
    try {
      const first = (
        await call('POST', '/api/accounts/codex/signin', { label: 'Work' })
      ).json() as {
        signInId: string;
      };
      await call('GET', `/api/accounts/codex/signin/${first.signInId}`);
      const list = (await call('GET', '/api/settings/shared')).json() as {
        secrets: { codex: Array<{ id: string; label: string }> };
      };
      const row = list.secrets.codex[0]!;
      expect(row.label).toBe('Work');
      await call('POST', `/api/accounts/codex/${row.id}/disconnect`);

      const again = (
        await call('POST', '/api/accounts/codex/signin', { accountId: row.id })
      ).json() as {
        signInId: string;
      };
      const res = await call('GET', `/api/accounts/codex/signin/${again.signInId}`);
      expect(res.json()).toMatchObject({ status: 'complete' });
      const after = (await call('GET', '/api/settings/shared')).json() as {
        secrets: { codex: Array<{ id: string; label: string }> };
      };
      expect(after.secrets.codex).toHaveLength(1);
      expect(after.secrets.codex[0]).toMatchObject({ id: row.id, label: 'Work' });
    } finally {
      await built.app.close();
    }
  });

  it('keeps waiting when OpenAI cannot be reached, and reports a refusal as failed', async () => {
    let mode: 'down' | 'refused' = 'down';
    const { built, call } = await makeApp(async () => {
      throw new ChatGPTSignInError(mode === 'down' ? 'unreachable' : 'rejected', 'nope');
    });
    try {
      const { signInId } = (await call('POST', '/api/accounts/codex/signin', {})).json() as {
        signInId: string;
      };
      const down = await call('GET', `/api/accounts/codex/signin/${signInId}`);
      expect(down.json()).toMatchObject({ status: 'pending' });
      mode = 'refused';
      const refused = await call('GET', `/api/accounts/codex/signin/${signInId}`);
      expect(refused.json()).toMatchObject({ status: 'failed', code: 'credential_rejected' });
    } finally {
      await built.app.close();
    }
  });

  it('forgets a cancelled sign-in and needs a credential', async () => {
    const { built, call } = await makeApp(approved);
    try {
      expect((await call('POST', '/api/accounts/codex/signin', {}, false)).statusCode).toBe(401);
      const { signInId } = (await call('POST', '/api/accounts/codex/signin', {})).json() as {
        signInId: string;
      };
      await call('DELETE', `/api/accounts/codex/signin/${signInId}`);
      const res = await call('GET', `/api/accounts/codex/signin/${signInId}`);
      expect(res.statusCode).toBe(410);
    } finally {
      await built.app.close();
    }
  });
});
