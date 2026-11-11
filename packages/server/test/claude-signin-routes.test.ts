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
    const post = (url: string, payload?: unknown, auth = true) =>
      built.app.inject({
        method: 'POST',
        url,
        headers: auth ? { authorization: `Bearer ${jwt}` } : {},
        ...(payload === undefined ? {} : { payload }),
      });
    return { built, post, exchanged };
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
});
