// An ACP agent's own sign-in on one host, started from a surface (spec/10 §
// Signing in → an ACP agent): the server asks the host, keeps how it is going
// for every surface to read, passes a pasted redirect back, and holds nothing of
// the login itself. Its result reaches the account states through the host's
// own `host.account` report.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import { AcpLogins } from '../src/acp-logins.js';
import { SharedSettingsService } from '../src/shared-settings.js';

function make(over: { online?: boolean; canLogin?: boolean } = {}) {
  const sent: Array<{ hostId: string; event: WireEvent }> = [];
  const logins = new AcpLogins({
    sendToHost: (hostId, event) => sent.push({ hostId, event }),
    isOnline: () => over.online ?? true,
    hostCanLogin: () => over.canLogin ?? true,
    hostName: (id) => (id === 'h1' ? 'Mac' : undefined),
    answerTimeoutMs: 50,
  });
  return { logins, sent };
}

const update = (over: Partial<Extract<WireEvent, { type: 'acp.login_update' }>>): WireEvent =>
  ({
    type: 'acp.login_update',
    hostId: 'h1',
    loginId: 'x',
    agentId: 'gemini',
    status: 'waiting',
    ...over,
  }) as WireEvent;

describe('AcpLogins', () => {
  it('asks the host, and follows what the host says until it ends', () => {
    const { logins, sent } = make();
    const started = logins.start('h1', 'gemini', 'oauth-personal');
    expect(started).toMatchObject({ hostId: 'h1', agentId: 'gemini', status: 'starting' });
    expect(sent).toEqual([
      {
        hostId: 'h1',
        event: {
          type: 'acp.login_request',
          hostId: 'h1',
          loginId: started.loginId,
          agentId: 'gemini',
          methodId: 'oauth-personal',
        },
      },
    ]);
    const id = started.loginId;
    logins.observe(update({ loginId: id, url: 'https://accounts.example.com/a', loopback: true }));
    expect(logins.get(id, 'gemini')).toMatchObject({
      status: 'waiting',
      url: 'https://accounts.example.com/a',
      loopback: true,
    });
    // Another host's word on it is not taken.
    logins.observe(update({ loginId: id, hostId: 'h2', status: 'complete' }));
    expect(logins.get(id, 'gemini').status).toBe('waiting');
    // A pasted redirect goes to the host that runs it.
    logins.callback(id, 'gemini', 'http://127.0.0.1:4000/oauth2callback?code=c');
    expect(sent.at(-1)).toEqual({
      hostId: 'h1',
      event: {
        type: 'acp.login_callback',
        hostId: 'h1',
        loginId: id,
        url: 'http://127.0.0.1:4000/oauth2callback?code=c',
      },
    });
    logins.observe(update({ loginId: id, status: 'complete' }));
    expect(logins.get(id, 'gemini')).toMatchObject({
      status: 'complete',
      url: 'https://accounts.example.com/a',
    });
    // Over is over: later words change nothing.
    logins.observe(update({ loginId: id, status: 'failed', message: 'late' }));
    expect(logins.get(id, 'gemini').status).toBe('complete');
  });

  it('refuses an offline host, a host too old to sign in, and a second sign-in to one agent', () => {
    expect(() => make({ online: false }).logins.start('h1', 'gemini', 'm')).toThrow(
      /Mac is offline/,
    );
    expect(() => make({ canLogin: false }).logins.start('h1', 'gemini', 'm')).toThrow(
      /cannot run an agent's sign-in until it is updated/,
    );
    const { logins } = make();
    logins.start('h1', 'gemini', 'm');
    expect(() => logins.start('h1', 'gemini', 'm')).toThrow(/already running on Mac/);
  });

  it('takes a pasted address only while the agent waits for one, and cancels on the host', () => {
    const { logins, sent } = make();
    const { loginId } = logins.start('h1', 'gemini', 'm');
    expect(() => logins.callback(loginId, 'gemini', 'http://x')).toThrow(/not waiting/);
    logins.observe(update({ loginId, userCode: 'ABCD-1234', url: 'https://d.example.com' }));
    expect(() => logins.callback(loginId, 'gemini', 'http://x')).toThrow(/not waiting/);
    expect(logins.cancel(loginId, 'gemini').status).toBe('cancelled');
    expect(sent.at(-1)?.event).toEqual({ type: 'acp.login_cancel', hostId: 'h1', loginId });
    expect(() => logins.get('nope', 'gemini')).toThrow(/ended or expired/);
    expect(() => logins.get(loginId, 'other')).toThrow(/ended or expired/);
  });

  it('fails a sign-in the host never answers, saying so', async () => {
    vi.useFakeTimers();
    try {
      const { logins } = make();
      const { loginId } = logins.start('h1', 'gemini', 'm');
      vi.advanceTimersByTime(60);
      expect(logins.get(loginId, 'gemini')).toMatchObject({
        status: 'failed',
        message: 'Mac did not answer; it may be restarting or offline',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('an agent signed in on one host, as an account state', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-acp-login-state-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the host’s report of its own sign-in, which the server holds no credential for', () => {
    const svc = new SharedSettingsService({
      dataDir: dir,
      sendToHost: () => undefined,
      onlineHostIds: () => [],
      broadcast: () => undefined,
    });
    const id = 'acp-login:h1:gemini';
    const report = (summary: Record<string, unknown>): void =>
      svc.handleHostEvent({
        type: 'host.account',
        hostId: 'h1',
        backendId: 'acp',
        connected: true,
        accounts: [{ id, label: 'Gemini CLI · signed in on Mac only', ...summary }],
      } as WireEvent);
    report({ connected: false, needsSignIn: true, error: 'not signed in' });
    expect(svc.accountState(id)).toEqual({ state: 'signed_out' });
    report({ connected: true, usage: { at: 5 } });
    expect(svc.accountState(id)).toEqual({ state: 'ready' });
    expect(svc.accountState('unknown-id')).toBeUndefined();
    // Never stored on the server.
    expect(svc.secretsSummary().acp).toBeUndefined();
  });
});

describe('ACP sign-in routes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-acp-login-routes-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('needs a surface credential, a known agent and an online host that can sign in', async () => {
    const { generateUserKeypair, mintSurfaceCredential } = await import('@patch/auth');
    const { buildAll } = await import('../src/app.js');
    const { Registry } = await import('../src/registry.js');
    const { InProcessHostLink } = await import('../src/host-link.js');
    const user = generateUserKeypair(() => new Uint8Array(32).fill(47));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'web', issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-web',
      surfaceKind: 'web',
      label: 'web',
    });
    const link = new InProcessHostLink();
    link.setHostId(null);
    const built = await buildAll({
      logger: false,
      registry,
      dataDir: dir,
      hostLink: link,
      jobsWatch: false,
      gcalSubscriptions: false,
    });
    const auth = { authorization: `Bearer ${jwt}` };
    try {
      const post = (url: string, payload: unknown, headers: Record<string, string> = auth) =>
        built.app.inject({ method: 'POST', url, headers, payload: payload as object });
      expect(
        (await post('/api/accounts/acp/gemini/login', { hostId: 'h1', methodId: 'm' }, {}))
          .statusCode,
      ).toBe(401);
      const unknown = await post('/api/accounts/acp/nope/login', { hostId: 'h1', methodId: 'm' });
      expect(unknown.statusCode).toBe(404);
      const offline = await post('/api/accounts/acp/gemini/login', {
        hostId: 'h1',
        methodId: 'oauth-personal',
      });
      expect(offline.statusCode).toBe(409);
      expect(offline.json()).toMatchObject({ error: 'host_offline' });
      const gone = await built.app.inject({
        method: 'GET',
        url: '/api/accounts/acp/gemini/login/nope',
        headers: auth,
      });
      expect(gone.statusCode).toBe(410);
    } finally {
      await built.app.close();
    }
  }, 60_000);
});
