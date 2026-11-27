// patch_view_* — the host side of Views (spec/14 § Views). POST /internal/view
// names the calling chat itself, relays the call to the server's views API over
// the link, and stamps a View card — a slim `chat.artifact` with id
// `view-<viewId>` — after a set. NO FALLBACK: an unknown chat, a downed link or a
// server refusal is a loud error and stamps nothing.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { buildControl } from '../src/control.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import type { ServerApiCall, ServerApiAnswer } from '../src/accountsClient.js';

const LOCAL_KEY = 'local-secret';
const AUTH = { authorization: `Bearer ${LOCAL_KEY}` };
const silent = pino({ level: 'silent' });

async function setup(answer: (c: ServerApiCall) => ServerApiAnswer | Promise<ServerApiAnswer>) {
  const home = mkdtempSync(join(tmpdir(), 'patch-view-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-view-folder-'));
  const events: WireEvent[] = [];
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'x',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
  });
  const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
  await new Promise((r) => setTimeout(r, 20));
  const calls: ServerApiCall[] = [];
  const app = await buildControl({
    localKey: LOCAL_KEY,
    daemon,
    serverApi: async (c) => {
      calls.push(c);
      return answer(c);
    },
  });
  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/internal/view', headers: AUTH, payload });
  return { post, chatId, events, calls };
}

const cards = (events: WireEvent[]) => events.filter((e) => e.type === 'chat.artifact');

describe('POST /internal/view', () => {
  it('relays a set under the calling chat and stamps a card', async () => {
    const t = await setup(() => ({ status: 200, body: { id: 'v1', title: 'Names', rev: 1 } }));
    const r = await t.post({
      op: 'set',
      callerChatId: t.chatId,
      title: 'Names',
      template: 'review-list',
      data: { items: [{ id: 'a', title: 'A' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ method: 'POST', path: '/api/views/agent' });
    expect(t.calls[0]!.body).toMatchObject({ chatId: t.chatId, op: 'set', title: 'Names' });
    expect(cards(t.events)).toHaveLength(1);
    expect(cards(t.events)[0]).toMatchObject({ artifactId: 'view-v1', title: 'Names' });
  });

  it('a patch and a read relay but add no card', async () => {
    const t = await setup(() => ({ status: 200, body: { id: 'v1', title: 'Names', rev: 2 } }));
    await t.post({
      op: 'patch',
      callerChatId: t.chatId,
      viewId: 'v1',
      ops: [{ op: 'remove', path: '/items/0' }],
      baseRev: 1,
    });
    await t.post({ op: 'read', callerChatId: t.chatId, viewId: 'v1' });
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]!.body).toMatchObject({ viewId: 'v1', baseRev: 1 });
    expect(cards(t.events)).toHaveLength(0);
  });

  it('shows the server’s refusal and stamps nothing', async () => {
    const t = await setup(() => ({ status: 409, body: { error: 'view is at rev 3, not 1' } }));
    const r = await t.post({
      op: 'set',
      callerChatId: t.chatId,
      title: 'x',
      template: 'review-list',
      data: {},
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toBe('view is at rev 3, not 1');
    expect(cards(t.events)).toHaveLength(0);
  });

  it('fails loudly when the link is down, the chat is unknown or the call is malformed', async () => {
    const down = await setup(() => {
      throw new Error('host→server link is offline');
    });
    const r = await down.post({ op: 'read', callerChatId: down.chatId, viewId: 'v1' });
    expect(r.statusCode).toBe(502);
    expect(r.json().message).toContain('offline');
    const t = await setup(() => ({ status: 200, body: {} }));
    expect((await t.post({ op: 'list', callerChatId: 'nope' })).statusCode).toBe(404);
    expect((await t.post({ op: 'bogus', callerChatId: t.chatId })).statusCode).toBe(400);
    expect(t.calls).toHaveLength(0);
  });
});
