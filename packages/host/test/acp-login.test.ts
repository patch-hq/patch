// An ACP agent's own sign-in, run on the host (spec/10 § Signing in → an ACP
// agent; decision 25): the methods it offers at `initialize`, `authenticate`
// with the hand-off it gives (an address to open, a code, a loopback redirect
// the host replays), and the result as this host's account for the agent.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthMethod } from '@agentclientprotocol/sdk';
import { AcpRegistry } from '../src/acpRegistry.js';
import { AcpAccounts } from '../src/acpAccounts.js';
import { isLoginMethod, readLoginHandoff, type LoginUpdate } from '../src/acpLogin.js';
import { fakeAgent } from './fixtures/acpFake.js';

/** What Gemini CLI 0.70 says at `initialize` (read from the real agent, no sign-in run). */
const GEMINI_AUTH_METHODS = [
  {
    id: 'oauth-personal',
    name: 'Log in with Google',
    description: 'Log in with your Google account',
  },
  {
    id: 'gemini-api-key',
    name: 'Gemini API key',
    description: 'Use an API key with Gemini Developer API',
    _meta: { 'api-key': { provider: 'google' } },
  },
  { id: 'vertex-ai', name: 'Vertex AI', description: 'Use an API key with Vertex AI GenAI API' },
  {
    id: 'gateway',
    name: 'AI API Gateway',
    description: 'Use a custom AI API Gateway',
    _meta: { gateway: { protocol: 'google', restartRequired: 'false' } },
  },
] as AuthMethod[];

describe('which sign-in methods log in', () => {
  it('takes only Gemini CLI’s Google login, never its key, Vertex or gateway methods', () => {
    expect(GEMINI_AUTH_METHODS.filter(isLoginMethod).map((m) => m.id)).toEqual(['oauth-personal']);
  });

  it('never takes a terminal method, which needs a terminal no surface has', () => {
    expect(isLoginMethod({ id: 'login', name: 'Log in', type: 'terminal' } as AuthMethod)).toBe(
      false,
    );
  });
});

describe('reading the hand-off an agent prints', () => {
  it('finds Gemini CLI’s address to open and the loopback address its provider redirects to', () => {
    const text =
      '\n\nAttempting to open authentication page in your browser.\nOtherwise navigate to:\n\n' +
      'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A41234%2Foauth2callback&access_type=offline&state=abc\n\n';
    expect(readLoginHandoff(text)).toEqual({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A41234%2Foauth2callback&access_type=offline&state=abc',
      loopback: { origin: 'http://127.0.0.1:41234', path: '/oauth2callback' },
    });
  });

  it('finds a device code and its address', () => {
    expect(
      readLoginHandoff(
        'To sign in, open https://fake.example.com/device and enter the code WXYZ-1234',
      ),
    ).toEqual({ url: 'https://fake.example.com/device', userCode: 'WXYZ-1234' });
  });

  it('finds nothing in output that offers nothing', () => {
    expect(readLoginHandoff('Waiting for authentication...\n')).toEqual({});
  });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'acp-login-'));
  const state = join(root, 'state');
  mkdirSync(state);
  const registry = new AcpRegistry({
    providerKey: () => undefined,
    baseEnv: () => ({
      ...process.env,
      FAKE_ACP_STATE: state,
      FAKE_ACP_LOGIN: '1',
      FAKE_ACP_NEED_KEY: '1',
    }),
    scratchDir: join(root, 'scratch'),
    clientVersion: '1.0.0',
  });
  // An agent that takes no key: logging in is the only way to sign it in.
  const agent = fakeAgent({ keys: {} });
  registry.setConfigured([agent]);
  return { registry, agent };
}

const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
};

describe('signing an agent in on this host', () => {
  it('lists the agent’s login methods from its probe, on its Settings → Hosts row', async () => {
    const { registry, agent } = setup();
    const probe = await registry.probe(agent);
    expect(probe.state).toEqual({ state: 'signed_out' });
    expect(probe.loginMethods?.map((m) => m.id)).toEqual(['browser-login', 'device-login']);
    expect(registry.backendEntries()[0]).toMatchObject({
      id: 'acp:fake',
      state: 'logged-out',
      loginMethods: [
        { id: 'browser-login', name: 'Log in with Fake', description: 'A browser sign-in' },
        { id: 'device-login', name: 'Log in with a code' },
      ],
    });
  }, 30_000);

  it('a browser sign-in: shows the address, refuses a stray address, replays the redirect, signs in', async () => {
    const { registry, agent } = setup();
    const updates: LoginUpdate[] = [];
    const login = registry.login(agent, 'browser-login', (u) => updates.push(u));
    await until(() => updates.some((u) => u.status === 'waiting'));
    const waiting = updates.find((u) => u.status === 'waiting')!;
    expect(updates[0]).toEqual({ status: 'starting' });
    expect(waiting.url).toMatch(/^https:\/\/accounts\.fake\.example\.com\/o\/oauth2\/auth\?/);
    expect(waiting.loopback).toBe(true);
    const back = login.current().loopback!;
    // Only the listener the agent announced is ever replayed to.
    await expect(login.replay('http://127.0.0.1:1/oauth2callback?code=good')).rejects.toThrow(
      /not the one Fake ACP is waiting on/,
    );
    await expect(login.replay('https://evil.example.com/?code=good')).rejects.toThrow();
    // The browser ended on the loopback page, which only the host can reach.
    await login.replay(`${back.origin}${back.path}?code=good&state=s`);
    expect(await login.done).toBe('complete');
    expect(updates.at(-1)).toEqual({ status: 'complete' });
    // The agent's own probe now finds it signed in here.
    await until(() => registry.lastProbe(agent.id)?.state.state === 'ready');
    expect(registry.lastProbe(agent.id)?.state).toEqual({ state: 'ready' });
  }, 30_000);

  it('a device-code sign-in shows the code and its address', async () => {
    const { registry, agent } = setup();
    const updates: LoginUpdate[] = [];
    const login = registry.login(agent, 'device-login', (u) => updates.push(u));
    expect(await login.done).toBe('complete');
    expect(updates.find((u) => u.status === 'waiting')).toEqual({
      status: 'waiting',
      url: 'https://fake.example.com/device',
      userCode: 'WXYZ-1234',
    });
  }, 30_000);

  it('a refused sign-in fails in the agent’s words; a cancelled one is cancelled', async () => {
    const { registry, agent } = setup();
    const updates: LoginUpdate[] = [];
    const refused = registry.login(agent, 'browser-login', (u) => updates.push(u));
    await until(() => refused.current().loopback !== undefined);
    const back = refused.current().loopback!;
    await expect(refused.replay(`${back.origin}${back.path}?code=bad`)).rejects.toThrow(/HTTP 400/);
    expect(await refused.done).toBe('failed');
    expect(updates.at(-1)?.message).toMatch(/The sign-in was refused/);

    const cancelled = registry.login(agent, 'browser-login', () => undefined);
    await until(() => cancelled.current().url !== undefined);
    cancelled.cancel();
    expect(await cancelled.done).toBe('cancelled');
  }, 30_000);
});

describe('the agent’s own sign-in as this host’s account', () => {
  it('is reported as an account of this host’s alone: signed in, then refused, then working', () => {
    let now = 1_000;
    const accounts = new AcpAccounts({ hostId: 'h1', now: () => now });
    expect(accounts.hostLogin('gemini')).toBeUndefined();
    accounts.setLogin('gemini', 'Gemini CLI · signed in on Mac only', true);
    const login = accounts.hostLogin('gemini')!;
    expect(login).toEqual({
      id: 'acp-login:h1:gemini',
      label: 'Gemini CLI · signed in on Mac only',
      signedIn: true,
    });
    expect(accounts.report('h1', 'acp').accounts).toEqual([
      {
        id: 'acp-login:h1:gemini',
        label: 'Gemini CLI · signed in on Mac only',
        connected: true,
        usage: { at: 1_000 },
      },
    ]);
    // A turn on it was refused as signed out.
    now = 2_000;
    accounts.markSignedOut(login.id, 'Gemini CLI is not signed in on this host');
    expect(accounts.report('h1', 'acp').accounts?.[0]).toEqual({
      id: 'acp-login:h1:gemini',
      label: 'Gemini CLI · signed in on Mac only',
      connected: false,
      needsSignIn: true,
      error: 'Gemini CLI is not signed in on this host',
    });
    // A turn worked on it again.
    now = 3_000;
    accounts.noteWorked(login.id);
    expect(accounts.report('h1', 'acp').accounts?.[0]).toMatchObject({
      connected: true,
      usage: { at: 3_000 },
    });
  });
});
