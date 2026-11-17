// Signing in to Claude from a surface (spec/10 § Signing in to Claude): the
// server starts the sign-in, keeps its PKCE verifier, and turns the code the
// person pastes back into a shared Claude account through the same validation
// a pasted token gets.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSignInError, generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

type Exchange = (a: { code: string; verifier: string; state: string }) => Promise<{
  accessToken: string;
  expiresAt: number;
}>;

describe('Claude sign-in routes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-claude-signin-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function makeApp(exchange: Exchange) {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(4));
    const data = mkdtempSync(join(dir, 'data-'));
    const registry = Registry.load(data);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-d', surfaceKind: 'desktop', label: 'd', issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-d',
      surfaceKind: 'desktop',
      label: 'd',
    });
    const exchanged: Array<{ code: string; verifier: string; state: string }> = [];
    const built = await buildAll({
      logger: false,
      registry,
      dataDir: data,
      hostLink: new InProcessHostLink(),
      validateClaudeToken: async (t: string) => ({
        kind: 'valid',
        organizationId: `org-${[...t].reverse().join('')}`,
      }),
      exchangeClaudeCode: async (a) => {
        exchanged.push(a);
        return exchange(a);
      },
      jobsWatch: false,
      gcalSubscriptions: false,
    });
    // A relayed request (a proxy header) is a browser somewhere else: the paste flow.
    const post = (url: string, payload?: unknown, auth = true, here = false) =>
      built.app.inject({
        method: 'POST',
        url,
        headers: {
          ...(auth ? { authorization: `Bearer ${jwt}` } : {}),
          ...(here ? {} : { 'x-forwarded-for': '203.0.113.9' }),
        },
        ...(payload === undefined ? {} : { payload }),
      });
    const get = (url: string) =>
      built.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${jwt}` } });
    const del = (url: string) =>
      built.app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${jwt}` } });
    return { built, post, get, del, exchanged };
  }

  it('starts a sign-in, takes the pasted code and adds the account', async () => {
    const { built, post, exchanged } = await makeApp(async () => ({
      accessToken: 'sk-ant-oat01-new',
      expiresAt: 0,
    }));
    try {
      const start = await post('/api/accounts/claude-code/signin');
      expect(start.statusCode, start.body).toBe(200);
      const { signInId, url } = start.json() as { signInId: string; url: string };
      expect(new URL(url).searchParams.get('scope')).toBe('user:inference');
      expect(start.body).not.toContain('verifier');
      const state = new URL(url).searchParams.get('state');

      const done = await post('/api/accounts/claude-code/signin/complete', {
        signInId,
        code: `the-code#${state}`,
        label: 'Personal',
      });
      expect(done.statusCode, done.body).toBe(200);
      expect(exchanged[0]).toMatchObject({ code: 'the-code', state });
      const claude = (done.json() as { secrets: { claude: Array<{ label: string }> } }).secrets
        .claude;
      expect(claude.map((c) => c.label)).toEqual(['Personal']);
      expect(done.body).not.toContain('sk-ant-oat01-new');

      // A finished sign-in cannot be finished twice.
      const again = await post('/api/accounts/claude-code/signin/complete', {
        signInId,
        code: `the-code#${state}`,
      });
      expect(again.statusCode).toBe(410);
    } finally {
      await built.app.close();
    }
  });

  it('refuses a code from another sign-in without calling Claude', async () => {
    const { built, post, exchanged } = await makeApp(async () => ({
      accessToken: 't',
      expiresAt: 0,
    }));
    try {
      const { signInId } = (await post('/api/accounts/claude-code/signin')).json() as {
        signInId: string;
      };
      const res = await post('/api/accounts/claude-code/signin/complete', {
        signInId,
        code: 'c#not-this-state',
      });
      expect(res.statusCode).toBe(400);
      expect(exchanged).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  it('says what Claude said when it refuses the code', async () => {
    const { built, post } = await makeApp(async () => {
      throw new ClaudeSignInError('rejected', 'Claude refused the code (HTTP 400: expired)');
    });
    try {
      const { signInId } = (await post('/api/accounts/claude-code/signin')).json() as {
        signInId: string;
      };
      const res = await post('/api/accounts/claude-code/signin/complete', { signInId, code: 'c' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'credential_rejected' });
      expect((res.json() as { message: string }).message).toContain('expired');
    } finally {
      await built.app.close();
    }
  });

  it('signs an existing row in again when given its id', async () => {
    let n = 0;
    const { built, post } = await makeApp(async () => ({
      accessToken: `tok-${++n}`,
      expiresAt: 0,
    }));
    try {
      const first = (await post('/api/accounts/claude-code/signin')).json() as {
        signInId: string;
      };
      const added = await post('/api/accounts/claude-code/signin/complete', {
        signInId: first.signInId,
        code: 'a',
      });
      const id = (added.json() as { secrets: { claude: Array<{ id: string }> } }).secrets.claude[0]!
        .id;
      const second = (await post('/api/accounts/claude-code/signin')).json() as {
        signInId: string;
      };
      const res = await post('/api/accounts/claude-code/signin/complete', {
        signInId: second.signInId,
        code: 'b',
        accountId: id,
      });
      expect(res.statusCode, res.body).toBe(200);
      const rows = (res.json() as { secrets: { claude: Array<{ id: string }> } }).secrets.claude;
      expect(rows.map((r) => r.id)).toEqual([id]);
    } finally {
      await built.app.close();
    }
  });

  it('needs a credential', async () => {
    const { built, post } = await makeApp(async () => ({ accessToken: 't', expiresAt: 0 }));
    try {
      expect((await post('/api/accounts/claude-code/signin', undefined, false)).statusCode).toBe(
        401,
      );
    } finally {
      await built.app.close();
    }
  });

  it('from the same machine, claude.ai returns the code to the server and nothing is pasted', async () => {
    const { built, post, get, exchanged } = await makeApp(async () => ({
      accessToken: 'sk-ant-oat01-loop',
      expiresAt: 0,
    }));
    try {
      const start = await post('/api/accounts/claude-code/signin', { label: 'Mine' }, true, true);
      expect(start.statusCode, start.body).toBe(200);
      const { signInId, url, mode } = start.json() as {
        signInId: string;
        url: string;
        mode: string;
      };
      expect(mode).toBe('loopback');
      const authorize = new URL(url);
      expect(authorize.searchParams.has('code')).toBe(false);
      const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
      expect(redirect.hostname).toBe('localhost');
      expect(redirect.pathname).toBe('/callback');
      expect(
        ((await get(`/api/accounts/claude-code/signin/${signInId}`)).json() as { status: string })
          .status,
      ).toBe('waiting');

      // The browser, after claude.ai (and any login detour) sends the person back.
      const back = await fetch(
        `http://127.0.0.1:${redirect.port}/callback?code=the-code&state=${authorize.searchParams.get('state')}`,
      );
      expect(back.status).toBe(200);
      await expect
        .poll(async () => (await get(`/api/accounts/claude-code/signin/${signInId}`)).json())
        .toEqual({ status: 'done' });
      expect(exchanged[0]).toMatchObject({
        code: 'the-code',
        redirectUri: redirect.toString(),
      });
      const state = (await get('/api/accounts/claude-code')).json() as {
        secrets: { claude: Array<{ label: string }> };
      };
      expect(state.secrets.claude.map((c) => c.label)).toEqual(['Mine']);
    } finally {
      await built.app.close();
    }
  });

  it('a loopback return with the wrong state is ignored; a refusal is reported', async () => {
    const { built, post, get } = await makeApp(async () => ({ accessToken: 't', expiresAt: 0 }));
    try {
      const { signInId, url } = (
        await post('/api/accounts/claude-code/signin', {}, true, true)
      ).json() as {
        signInId: string;
        url: string;
      };
      const authorize = new URL(url);
      const port = new URL(authorize.searchParams.get('redirect_uri')!).port;
      const stray = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=other`);
      expect(stray.status).toBe(404);
      expect(
        ((await get(`/api/accounts/claude-code/signin/${signInId}`)).json() as { status: string })
          .status,
      ).toBe('waiting');
      await fetch(
        `http://127.0.0.1:${port}/callback?error=access_denied&state=${authorize.searchParams.get('state')}`,
      );
      await expect
        .poll(async () => (await get(`/api/accounts/claude-code/signin/${signInId}`)).json())
        .toMatchObject({ status: 'failed' });
    } finally {
      await built.app.close();
    }
  });

  it('cancelling a loopback sign-in closes its listener', async () => {
    const { built, post, del } = await makeApp(async () => ({ accessToken: 't', expiresAt: 0 }));
    try {
      const { signInId, url } = (
        await post('/api/accounts/claude-code/signin', {}, true, true)
      ).json() as {
        signInId: string;
        url: string;
      };
      const port = new URL(new URL(url).searchParams.get('redirect_uri')!).port;
      const res = await del(`/api/accounts/claude-code/signin/${signInId}`);
      expect(res.statusCode).toBe(204);
      await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
    } finally {
      await built.app.close();
    }
  });
});
