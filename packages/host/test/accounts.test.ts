// Picking an account on `patch_spawn`, and listing/reordering the shared
// accounts over the server link (spec/06 § Cross-chat tools).

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { buildControl } from '../src/control.js';
import { MemoryJobsStore } from '../src/jobs-interface.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import {
  AccountsClient,
  AccountsRpcError,
  ServerApiClient,
  resolveAccountRef,
  type AccountsRequest,
} from '../src/accountsClient.js';

const KEY = 'local-secret';
const AUTH = { authorization: `Bearer ${KEY}` };
const HELD = [
  { id: 'acc-1', label: 'Work' },
  { id: 'acc-2', label: 'Personal' },
];

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-acct-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-acct-folder-'));
  const spawned: Array<{ preferredAccountId?: string }> = [];
  const daemon = new Daemon({
    hostId: 'host-a',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'x',
    emit: () => undefined,
    logger: pino({ level: 'silent' }),
    now: () => 1_700_000_000_000,
  });
  const realSpawn = daemon.spawnChat.bind(daemon);
  daemon.spawnChat = ((req) => {
    spawned.push(req);
    return realSpawn(req);
  }) as typeof daemon.spawnChat;
  return { daemon, jobs: new MemoryJobsStore({ now: () => 1_700_000_000_000 }), folder, spawned };
}

describe('resolveAccountRef', () => {
  it('takes an id, or a label in any case', () => {
    expect(resolveAccountRef('acc-2', HELD)).toBe('acc-2');
    expect(resolveAccountRef('work', HELD)).toBe('acc-1');
  });
  it('refuses an unknown account, naming what is held', () => {
    expect(() => resolveAccountRef('nope', HELD)).toThrow(/Work \(acc-1\), Personal \(acc-2\)/);
  });
  it('refuses a label two accounts share', () => {
    expect(() =>
      resolveAccountRef('x', [
        { id: 'a', label: 'X' },
        { id: 'b', label: 'x' },
      ]),
    ).toThrow(/more than one account/);
  });
});

describe('/internal/spawn account', () => {
  it('starts the chat on the named account, found by label', async () => {
    const { daemon, jobs, folder, spawned } = setup();
    const app = await buildControl({
      localKey: KEY,
      daemon,
      jobs,
      heldAccounts: () => HELD,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, account: 'personal', model: 'claude-sonnet-5-5' },
      });
      expect(res.statusCode).toBe(200);
      expect(spawned[0]?.preferredAccountId).toBe('acc-2');
      const chatId = res.json().chatId as string;
      expect(daemon.list().find((c) => c.chatId === chatId)?.preferredAccountId).toBe('acc-2');
    } finally {
      await app.close();
    }
  });

  it('refuses an account the host does not hold and creates no chat', async () => {
    const { daemon, jobs, folder, spawned } = setup();
    const app = await buildControl({ localKey: KEY, daemon, jobs, heldAccounts: () => HELD });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, account: 'nobody', model: 'claude-sonnet-5-5' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'account_not_found' });
      expect(res.json().message).toMatch(/holds: Work \(acc-1\)/);
      expect(spawned).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('sends the resolved id with a cross-host spawn', async () => {
    const { daemon, jobs, folder } = setup();
    const calls: Array<{ preferredAccountId?: string }> = [];
    const app = await buildControl({
      localKey: KEY,
      daemon,
      jobs,
      heldAccounts: () => HELD,
      isHostOnline: () => true,
      spawnOnRemoteHost: async (req) => {
        calls.push(req);
        return { chatId: 'c-remote' };
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, host: 'host-b', callerChatId: 'mgr', account: 'Work' },
      });
      expect(res.statusCode).toBe(200);
      expect(calls[0]?.preferredAccountId).toBe('acc-1');
    } finally {
      await app.close();
    }
  });
});

describe('accounts routes', () => {
  it('relays list, order and strategy to the server, and the CLI route needs the local key', async () => {
    const { daemon, jobs } = setup();
    const asked: AccountsRequest[] = [];
    const app = await buildControl({
      localKey: KEY,
      daemon,
      jobs,
      accountsRpc: async (req) => {
        asked.push(req);
        return { claude: HELD };
      },
    });
    try {
      expect((await app.inject({ method: 'GET', url: '/accounts' })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url: '/internal/accounts', headers: AUTH })).json(),
      ).toEqual({ claude: HELD });
      await app.inject({
        method: 'PUT',
        url: '/accounts/claude-code/order',
        headers: AUTH,
        payload: { accountIds: ['acc-2', 'acc-1'] },
      });
      await app.inject({
        method: 'PUT',
        url: '/accounts/codex/strategy',
        headers: AUTH,
        payload: { strategy: 'least-used' },
      });
      expect(asked).toEqual([
        { op: 'list' },
        { op: 'order', backendId: 'claude-code', accountIds: ['acc-2', 'acc-1'] },
        { op: 'strategy', backendId: 'codex', strategy: 'least-used' },
      ]);
    } finally {
      await app.close();
    }
  });

  it("passes the server's refusal through with its code", async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({
      localKey: KEY,
      daemon,
      jobs,
      accountsRpc: async () => {
        throw new AccountsRpcError(
          'invalid_order',
          'The order must name each account exactly once',
        );
      },
    });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/accounts/claude-code/order',
        headers: AUTH,
        payload: { accountIds: ['acc-1'] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_order' });
    } finally {
      await app.close();
    }
  });

  it('503s when the server link is offline, naming it', async () => {
    const { daemon, jobs } = setup();
    const client = new AccountsClient({ emit: () => undefined, isLinkOnline: () => false });
    const app = await buildControl({ localKey: KEY, daemon, jobs, accountsRpc: client.request });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/accounts',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().message).toMatch(/link is offline/);
    } finally {
      await app.close();
    }
  });
});

describe('AccountsClient', () => {
  it('resolves on the matching response and rejects with the server code on a refusal', async () => {
    const sent: WireEvent[] = [];
    let n = 0;
    const client = new AccountsClient({
      emit: (e) => sent.push(e),
      isLinkOnline: () => true,
      idGen: () => `r${++n}`,
    });
    const ok = client.request({ op: 'list' });
    expect(sent[0]).toMatchObject({ type: 'patch.accounts.request', requestId: 'r1', op: 'list' });
    client.handleResponse({
      type: 'patch.accounts.response',
      requestId: 'r1',
      ok: true,
      result: { claude: [] },
    });
    await expect(ok).resolves.toEqual({ claude: [] });

    const bad = client.request({ op: 'strategy', backendId: 'claude-code', strategy: 'priority' });
    client.handleResponse({
      type: 'patch.accounts.response',
      requestId: 'r2',
      ok: false,
      error: { code: 'unknown_backend', message: 'nope' },
    });
    await expect(bad).rejects.toMatchObject({ code: 'unknown_backend', message: 'nope' });
  });

  it('times out loudly when the server never answers', async () => {
    const client = new AccountsClient({
      emit: () => undefined,
      isLinkOnline: () => true,
      requestTimeoutMs: 10,
    });
    await expect(client.request({ op: 'list' })).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('/server-api', () => {
  it('relays one REST call over the link and returns its status and body', async () => {
    const { daemon, jobs } = setup();
    const sent: WireEvent[] = [];
    let n = 0;
    const api = new ServerApiClient({
      emit: (e) => {
        sent.push(e);
        queueMicrotask(() =>
          api.handleResponse({
            type: 'patch.api.response',
            requestId: 'q1',
            status: 409,
            body: { error: 'invalid_order' },
          }),
        );
      },
      isLinkOnline: () => true,
      idGen: () => `q${++n}`,
    });
    const app = await buildControl({ localKey: KEY, daemon, jobs, serverApi: api.request });
    try {
      const noKey = await app.inject({ method: 'POST', url: '/server-api', payload: {} });
      expect(noKey.statusCode).toBe(401);
      const res = await app.inject({
        method: 'POST',
        url: '/server-api',
        headers: AUTH,
        payload: {
          method: 'PUT',
          path: '/api/accounts/claude-code/order',
          body: { accountIds: ['a'] },
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'invalid_order' });
      expect(sent[0]).toMatchObject({
        type: 'patch.api.request',
        method: 'PUT',
        path: '/api/accounts/claude-code/order',
      });
    } finally {
      await app.close();
    }
  });
});
