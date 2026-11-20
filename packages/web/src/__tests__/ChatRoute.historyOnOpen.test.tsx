// Regression: opening a chat that first appeared AFTER the socket connected
// (e.g. spawned on the phone, learned about via the always-on state-level
// fanout) must ask the server for its history on open. The feed resumed at
// connect only covers chats held then; without a per-open read such a chat
// renders "No messages yet" forever (spec/03 § Chat history, spec/14 § Main
// chat panel).

import { it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { PatchWs, setActiveWs } from '../api/ws.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';

class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  readyState = 0;
  url: string;
  sent: string[] = [];
  listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  addEventListener(name: string, cb: (e: MessageEvent) => void): void {
    (this.listeners[name] ??= []).push(cb);
  }
  removeEventListener(): void {}
  emit(name: string, data: unknown): void {
    for (const cb of this.listeners[name] ?? []) cb(data as MessageEvent);
  }
  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }
}

function historyFramesFor(
  fake: FakeWS,
  chatId: string,
): Array<{ requestId: string; after?: number }> {
  return fake.sent
    .map(
      (s) => JSON.parse(s) as { type: string; chatId?: string; requestId: string; after?: number },
    )
    .filter((e) => e.type === 'chat.history_request' && e.chatId === chatId)
    .map((e) => ({ requestId: e.requestId, ...(e.after !== undefined ? { after: e.after } : {}) }));
}

function followsOf(fake: FakeWS): string[] {
  return fake.sent
    .map((s) => JSON.parse(s) as { type: string; follow?: Array<{ chatId: string }> })
    .filter((e) => e.type === 'feed.resume')
    .flatMap((e) => (e.follow ?? []).map((f) => f.chatId));
}

beforeEach(() => {
  FakeWS.instances = [];
  (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setHostOnline('d1', true);
  setActiveWs(null);
});

afterEach(() => {
  cleanup();
  setActiveWs(null);
});

it('asks for history when opening a chat that appeared after connect', async () => {
  const CHAT = 'c-from-phone';

  // 1. Socket connects with NO chats known yet.
  const ws = new PatchWs('ws://test/ws');
  ws.connect();
  await Promise.resolve();
  const fake = FakeWS.instances[FakeWS.instances.length - 1]!;
  fake.open();
  expect(historyFramesFor(fake, CHAT)).toHaveLength(0);

  // 2. The chat now appears in the sidebar (state-level fanout from a spawn on
  //    another surface) — metadata + preview only, empty transcript.
  useChatStore.getState().hydrate([
    {
      chatId: CHAT,
      hostId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'Petty Spurge Deep Dive',
      folder: 'portfolio',
      chatStatus: { state: 'idle', since: 0 },
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);

  // 3. Opening it must ask for its last screen (no `after`).
  render(
    <MemoryRouter initialEntries={[`/chats/${CHAT}`]}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={ws} />} />
      </Routes>
    </MemoryRouter>,
  );

  // Awaited, not synchronous: opening a chat now reads this device's cached
  // transcript first (spec/12 § Cold start) and only then asks the server, so
  // the ask carries a cursor past whatever the device already holds. With
  // nothing cached — this test — it asks for the last screen, a tick later.
  await waitFor(() => expect(historyFramesFor(fake, CHAT)).toHaveLength(1));
  expect(historyFramesFor(fake, CHAT)[0]).not.toHaveProperty('after');
});

// The other half of the same seam. A COLD start opens a chat before the socket
// is up: ChatRoute's ask is dropped, and the account feed resumed on connect
// follows the open chat, so its last screen comes once, from the feed.
it('asks for a chat’s transcript once when open and connect race on a cold start', async () => {
  const CHAT = 'c-cold-open';
  const ws = new PatchWs('ws://test/ws');
  ws.connect();
  await Promise.resolve();
  const fake = FakeWS.instances[FakeWS.instances.length - 1]!;

  // Open the chat BEFORE the socket is up — the cold-start order.
  useChatStore.getState().hydrate([
    {
      chatId: CHAT,
      hostId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'Cold open',
      folder: 'portfolio',
      chatStatus: { state: 'idle', since: 0 },
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
  useChatStore.getState().setActiveChat(CHAT);
  render(
    <MemoryRouter initialEntries={[`/chats/${CHAT}`]}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={ws} />} />
      </Routes>
    </MemoryRouter>,
  );
  fake.open();
  fake.emit('message', {
    data: JSON.stringify({
      type: 'auth.ok',
      accountId: 'a',
      surfaceId: 's',
      hosts: [],
      accountFeed: true,
    }),
  });

  expect(followsOf(fake).filter((c) => c === CHAT)).toHaveLength(1);
  expect(historyFramesFor(fake, CHAT)).toHaveLength(0);
});

// …but a genuine reconnect must still catch up, even from the same cursor: the
// previous request may have died with the old socket before a single event came
// back. The suppression is per-connection, not for all time.
it('asks again from the same cursor after a reconnect', async () => {
  const CHAT = 'c-reconnect';
  const ws = new PatchWs('ws://test/ws');
  ws.connect();
  await Promise.resolve();
  const first = FakeWS.instances[FakeWS.instances.length - 1]!;
  first.open();
  useChatStore.getState().hydrate([
    {
      chatId: CHAT,
      hostId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'Reconnect',
      folder: 'portfolio',
      chatStatus: { state: 'idle', since: 0 },
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
  useChatStore.getState().setActiveChat(CHAT);
  ws.requestHistory(CHAT);
  expect(historyFramesFor(first, CHAT)).toHaveLength(1);

  // The socket drops before any event arrives; a new one comes up.
  first.emit('close', { code: 1006, reason: '' });
  ws.reconnectNow();
  await Promise.resolve();
  const second = FakeWS.instances[FakeWS.instances.length - 1]!;
  second.open();
  ws.requestHistory(CHAT);

  expect(historyFramesFor(second, CHAT)).toHaveLength(1);
});

// A history request that never gets an answer (the link dropped as it was
// sent) used to leave the chat on "No messages yet" for good: the
// same-cursor guard treated every later ask as a repeat. An opened chat that
// is still empty asks again, with backoff, until something arrives.
it('asks again when an opened chat is still empty after its history read went unanswered', async () => {
  const CHAT = 'c-unanswered';
  const ws = new PatchWs('ws://test/ws');
  ws.connect();
  await Promise.resolve();
  const fake = FakeWS.instances[FakeWS.instances.length - 1]!;
  fake.open();
  useChatStore.getState().hydrate([
    {
      chatId: CHAT,
      hostId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'Unanswered',
      folder: 'portfolio',
      chatStatus: { state: 'idle', since: 0 },
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
  render(
    <MemoryRouter initialEntries={[`/chats/${CHAT}`]}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={ws} />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(historyFramesFor(fake, CHAT)).toHaveLength(1));
  // Nothing ever replies. The retry must go out on its own.
  await waitFor(() => expect(historyFramesFor(fake, CHAT).length).toBeGreaterThanOrEqual(2), {
    timeout: 6000,
  });
});

// Until the server's answer lands the empty area says it is loading — "No
// messages yet" on a chat that has history is a lie.
it('says Loading… until the history answer lands, then the empty state if nothing came', async () => {
  const CHAT = 'c-loading';
  const ws = new PatchWs('ws://test/ws');
  ws.connect();
  await Promise.resolve();
  const fake = FakeWS.instances[FakeWS.instances.length - 1]!;
  fake.open();
  useChatStore.getState().hydrate([
    {
      chatId: CHAT,
      hostId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'Loading',
      folder: 'portfolio',
      chatStatus: { state: 'idle', since: 0 },
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
  const view = render(
    <MemoryRouter initialEntries={[`/chats/${CHAT}`]}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={ws} />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(historyFramesFor(fake, CHAT)).toHaveLength(1));
  const title = (): string | undefined =>
    view.container.querySelector('.empty-chat-title')?.textContent ?? undefined;
  expect(title()).toBe('Loading…');

  expect(useChatStore.getState().replaying[CHAT]).toBe(true);
  fake.emit('message', {
    data: JSON.stringify({
      type: 'chat.history',
      requestId: historyFramesFor(fake, CHAT)[0]!.requestId,
      chatId: CHAT,
      entries: [],
      more: false,
      through: -1,
      pending: [],
      queued: [],
    }),
  });
  await waitFor(() => expect(title()).toBe('No messages yet'));
});

it('stops saying Loading… when the socket carrying the history read drops', async () => {
  const CHAT = 'c-loading-drop';
  const ws = new PatchWs('ws://test/ws');
  ws.connect();
  await Promise.resolve();
  const fake = FakeWS.instances[FakeWS.instances.length - 1]!;
  fake.open();
  ws.requestHistory(CHAT);
  expect(useChatStore.getState().replaying[CHAT]).toBe(true);
  fake.emit('close', { code: 1006, reason: '' });
  expect(useChatStore.getState().replaying[CHAT]).toBeUndefined();
});
