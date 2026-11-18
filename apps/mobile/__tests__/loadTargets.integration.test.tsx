// The load targets on the phone (spec/05 § Loading, spec/19 § Load targets),
// the mobile half of packages/web/e2e/load-targets.spec.ts. The real Chats tab,
// chat screen, store, on-device copy and WebSocket client run together; only
// the server is a stand-in that answers the wire protocol.
//
//   1. The chat list and a followed chat render from the device copy, on a
//      fresh launch, while the network answers nothing.
//   2. A chat of 10,000 entries shows its last screen within a second of
//      opening, from a phone that holds nothing for it.
//   3. Nothing shown is lost across a reconnect, and nothing arrives twice.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type React from 'react';
import { installFakeWebSocket, restoreWebSocket, FakeWebSocket } from './testUtils/fakeWebSocket';
import { __clearAllMmkv } from './stubs/mmkv';

// Every REST call goes nowhere and never answers: the network is down.
const never = (): Promise<never> => new Promise(() => undefined);
vi.mock('../src/api/rest', () => ({
  api: new Proxy({}, { get: () => () => new Promise(() => undefined) }),
}));
vi.mock('../src/lib/voiceNote', () => ({
  startVoiceNote: vi.fn(),
  releaseVoiceNoteIfHeld: vi.fn(),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

const SMALL = 'chat-small';
const LONG = 'chat-long';
const LONG_ENTRIES = 10_000;
const entryText = (seq: number): string => `entry-${String(seq).padStart(6, '0')}`;
const entry = (chatId: string, seq: number) => ({
  type: 'chat.message',
  chatId,
  seq,
  role: 'assistant',
  content: entryText(seq),
});
const row = (chatId: string, name: string, lastUpdated: number) => ({
  chatId,
  name,
  hostId: 'h1',
  folder: '/w',
  activity: 'idle' as const,
  permissionMode: 'auto' as const,
  status: 'active' as const,
  pinned: false,
  pinnedAt: null,
  lastUpdated,
  pendingWake: null,
  snoozedUntil: null,
});
const authOk = { type: 'auth.ok', accountId: 'a', surfaceId: 's', hosts: [], accountFeed: true };

/**
 * A fresh launch of the app: every module, the store included, is loaded anew,
 * so whatever shows came from the on-device copy (MMKV survives the reset, as
 * it survives a restart on a phone).
 */
async function launch() {
  vi.resetModules();
  const React = (await import('react')).default;
  const render = await import('./testUtils/render');
  const { useChatStore } = await import('../src/stores/chatStore');
  const { usePresenceStore } = await import('../src/stores/presenceStore');
  const { getWs, resetWs } = await import('../src/api/ws');
  const { saveCredential } = await import('../src/lib/credential');
  const router = await import('./stubs/expo-router');
  const ChatsScreen = (await import('../app/(tabs)/chats')).default;
  const ChatScreen = (await import('../app/chats/[chatId]')).default;
  saveCredential('a.b.c');
  usePresenceStore.setState({ connection: 'connecting' });
  const el = (C: React.ComponentType) => React.createElement(C);
  return { render, useChatStore, getWs, resetWs, router, ChatsScreen, ChatScreen, el };
}

type App = Awaited<ReturnType<typeof launch>>;
let app: App | null = null;

const frames = (sock: FakeWebSocket): Array<Record<string, unknown>> =>
  sock.sent.map((s) => JSON.parse(s as string) as Record<string, unknown>);

/** The server's answer to the phone's last-screen ask for a chat of `total` entries. */
function answerHistory(sock: FakeWebSocket, chatId: string, total: number): void {
  const ask = frames(sock).find(
    (f) => f['type'] === 'chat.history_request' && f['chatId'] === chatId,
  );
  if (ask === undefined)
    throw new Error(
      `the phone never asked for ${chatId}: ${JSON.stringify(frames(sock).map((f) => f['type']))}`,
    );
  const limit = ask['limit'] as number;
  const after = ask['after'] as number | undefined;
  const from = after !== undefined ? after + 1 : Math.max(0, total - limit);
  const to = Math.min(total, from + limit);
  sock.emitMessage(
    JSON.stringify({
      type: 'chat.history',
      requestId: ask['requestId'],
      chatId,
      entries: Array.from({ length: to - from }, (_, i) => entry(chatId, from + i)),
      more: after === undefined ? from > 0 : to < total,
      through: total - 1,
      pending: [],
      queued: [],
    }),
  );
}

beforeEach(() => {
  installFakeWebSocket();
  vi.useFakeTimers();
  __clearAllMmkv();
  vi.stubGlobal('fetch', vi.fn(never));
});

afterEach(() => {
  app?.resetWs();
  app = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  restoreWebSocket();
});

describe('load targets on the phone', { timeout: 120_000 }, () => {
  it('the chat list and a followed chat render from the device copy while the network answers nothing', async () => {
    // First launch, server reachable: the phone comes to hold the list and the
    // entries of the chat it opened.
    app = await launch();
    const first = app;
    first.useChatStore.getState().hydrate([row(SMALL, 'small chat', 2), row(LONG, 'long chat', 1)]);
    first.getWs().connect();
    const sock = FakeWebSocket.last();
    first.render.actSync(() => sock.emitOpen());
    first.render.actSync(() => sock.emitMessage(JSON.stringify(authOk)));
    first.router.__setLocalSearchParams({ chatId: SMALL });
    const open = first.render.renderRN(first.el(first.ChatScreen));
    first.render.actSync(() => answerHistory(sock, SMALL, 5));
    expect(first.render.hasText(open.root, entryText(4))).toBe(true);
    // The copy is written behind a short debounce.
    first.render.actSync(() => vi.advanceTimersByTime(2000));
    first.render.actSync(() => open.unmount());
    first.resetWs();

    // Second launch: the socket never connects and no request is answered.
    // Nothing is awaited and no timer runs before the screens are read.
    app = await launch();
    const second = app;
    const list = second.render.renderRN(second.el(second.ChatsScreen));
    expect(second.render.hasText(list.root, 'small chat')).toBe(true);
    expect(second.render.hasText(list.root, 'long chat')).toBe(true);
    second.router.__setLocalSearchParams({ chatId: SMALL });
    const chat = second.render.renderRN(second.el(second.ChatScreen));
    for (let seq = 0; seq < 5; seq++)
      expect(second.render.hasText(chat.root, entryText(seq))).toBe(true);
  });

  it('a chat of 10,000 entries shows its last screen within a second of opening, from a phone that holds nothing for it', async () => {
    app = await launch();
    const a = app;
    a.useChatStore.getState().hydrate([row(LONG, 'long chat', 1)]);
    a.getWs().connect();
    const sock = FakeWebSocket.last();
    a.render.actSync(() => sock.emitOpen());
    a.render.actSync(() => sock.emitMessage(JSON.stringify(authOk)));

    a.router.__setLocalSearchParams({ chatId: LONG });
    const started = process.hrtime.bigint();
    const screen = a.render.renderRN(a.el(a.ChatScreen));
    a.render.actSync(() => answerHistory(sock, LONG, LONG_ENTRIES));
    const tookMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(a.render.hasText(screen.root, entryText(LONG_ENTRIES - 1))).toBe(true);
    expect(tookMs, `last screen took ${Math.round(tookMs)}ms to render`).toBeLessThan(1000);
    // Only a screen of it: older entries are paged in as the reader scrolls up.
    const ask = frames(sock).find((f) => f['type'] === 'chat.history_request');
    expect(ask!['limit']).toBeLessThan(500);
    expect(a.render.hasText(screen.root, entryText(0))).toBe(false);
    expect(a.useChatStore.getState().timelines[LONG]!.length).toBeLessThan(500);
  });

  it('nothing shown is lost across a reconnect, and nothing arrives twice', async () => {
    app = await launch();
    const a = app;
    a.useChatStore.getState().hydrate([row(SMALL, 'small chat', 1)]);
    a.getWs().connect();
    const sock = FakeWebSocket.last();
    a.render.actSync(() => sock.emitOpen());
    a.render.actSync(() => sock.emitMessage(JSON.stringify(authOk)));
    a.router.__setLocalSearchParams({ chatId: SMALL });
    const screen = a.render.renderRN(a.el(a.ChatScreen));
    a.render.actSync(() => answerHistory(sock, SMALL, 5));

    // Mid-turn: entries arrive live, the link drops, entries keep coming.
    const live = (s: FakeWebSocket, seq: number) =>
      a.render.actSync(() => {
        s.emitMessage(JSON.stringify(entry(SMALL, seq)));
        vi.advanceTimersByTime(50);
      });
    for (let seq = 5; seq < 10; seq++) live(sock, seq);
    expect(a.render.hasText(screen.root, entryText(9))).toBe(true);
    a.render.actSync(() => sock.emitClose(1006, 'network lost'));
    // 10..19 happen while the phone cannot hear.

    // The phone redials on its own.
    a.render.actSync(() => vi.advanceTimersByTime(30_000));
    const back = FakeWebSocket.last();
    expect(back).not.toBe(sock);
    a.render.actSync(() => back.emitOpen());
    a.render.actSync(() => back.emitMessage(JSON.stringify(authOk)));
    const resume = frames(back).find((f) => f['type'] === 'feed.resume');
    const followed = (resume!['follow'] as Array<{ chatId: string; after: number }>).find(
      (f) => f.chatId === SMALL,
    );
    // It says how far it got, and the server catches it up from there.
    expect(followed?.after).toBe(9);
    a.render.actSync(() =>
      back.emitMessage(
        JSON.stringify({
          type: 'chat.history',
          requestId: 'feed',
          chatId: SMALL,
          entries: Array.from({ length: 10 }, (_, i) => entry(SMALL, 10 + i)),
          more: false,
          through: 19,
          pending: [],
          queued: [],
        }),
      ),
    );
    // A live frame racing the catch-up repeats the last one.
    live(back, 19);
    for (let seq = 20; seq < 25; seq++) live(back, seq);

    expect(a.render.hasText(screen.root, entryText(24))).toBe(true);
    const seqs = a.useChatStore
      .getState()
      .timelines[SMALL]!.filter((e) => e.kind !== 'error')
      .map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i));
    for (let seq = 0; seq < 25; seq++)
      expect(
        a.render.findAllHost(
          screen.root,
          (i) => i.type === 'Text' && a.render.textOf(i) === entryText(seq),
        ).length,
      ).toBe(1);
  });
});
