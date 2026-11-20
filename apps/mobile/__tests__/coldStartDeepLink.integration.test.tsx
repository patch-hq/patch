// The tapped-notification cold start, end to end across the real chat detail
// screen and the real WebSocket client (spec/12 § When a surface requests a
// replay; spec/15 § Push notifications).
//
// Every other chat-detail test doubles `api/ws`, so none of them can see the
// ordering that actually breaks on a phone: a push tap launches the app and
// deep-links to /chats/<id> while the socket is still opening, and for a chat
// the roster has never heard of. The screen asks for its replay into a closed
// socket, the frame is dropped, and unless the connect handler asks again the
// chat is never added to the server's per-connection `watchedChats` — so no
// chat.message, tool call or permission prompt for it is ever fanned out.
// The user taps the notification and looks at a blank chat.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderRN, actSync, hasText } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams } from './stubs/expo-router';
import { installFakeWebSocket, restoreWebSocket, FakeWebSocket } from './testUtils/fakeWebSocket';
import { saveCredential } from '../src/lib/credential';
import { getWs, resetWs, STORE_BATCH_MS } from '../src/api/ws';

vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    deleteChat: vi.fn(async () => ({ ok: true as const })),
    pinChat: vi.fn(async () => undefined),
    snoozeChat: vi.fn(async () => undefined),
  },
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

const PUSHED_CHAT = 'c_from_push';

let ChatDetailScreen: React.ComponentType;

beforeEach(async () => {
  installFakeWebSocket();
  vi.useFakeTimers();
  saveCredential('a.b.c');
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connecting');
  __setLocalSearchParams({ chatId: PUSHED_CHAT });
  const mod = await import('../app/chats/[chatId]');
  ChatDetailScreen = mod.default;
});

afterEach(() => {
  resetWs();
  vi.useRealTimers();
  restoreWebSocket();
  vi.restoreAllMocks();
});

function asksOn(sock: FakeWebSocket): Array<Record<string, unknown>> {
  return sock.sent
    .map((s) => JSON.parse(s as string) as Record<string, unknown>)
    .filter((m) => m['type'] === 'chat.history_request');
}

function followsOn(sock: FakeWebSocket): string[] {
  return sock.sent
    .map((s) => JSON.parse(s as string) as { type: string; follow?: Array<{ chatId: string }> })
    .filter((m) => m.type === 'feed.resume')
    .flatMap((m) => (m.follow ?? []).map((f) => f.chatId));
}

describe('cold start from a tapped notification', () => {
  it('subscribes the deep-linked chat once the socket opens, and its messages then render', () => {
    // 1. The app launches and starts dialling. Nothing is open yet.
    const ws = getWs();
    ws.connect();
    const sock = FakeWebSocket.last();

    // 2. The push tap deep-links straight into a chat the roster has never
    //    listed — no cached row, GET /api/chats has not answered.
    expect(useChatStore.getState().chats[PUSHED_CHAT]).toBeUndefined();
    const r = renderRN(<ChatDetailScreen />);
    // The screen's mount-time request goes nowhere: the socket is CONNECTING.
    expect(asksOn(sock)).toEqual([]);

    // 3. The socket finishes connecting and is greeted; the feed it resumes
    //    follows the chat on screen.
    actSync(() => {
      sock.emitOpen();
      sock.emitMessage(
        JSON.stringify({
          type: 'auth.ok',
          hosts: [],
          accountId: 'a',
          surfaceId: 's',
          accountFeed: true,
        }),
      );
    });
    expect(followsOn(sock).filter((c) => c === PUSHED_CHAT)).toHaveLength(1);

    // 4. Following is what makes the chat a WATCHED chat, so its detail events
    //    arrive and the screen stops being blank.
    actSync(() => {
      sock.emitMessage(
        JSON.stringify({
          type: 'chat.message',
          chatId: PUSHED_CHAT,
          seq: 0,
          role: 'assistant',
          content: 'the job finished',
        }),
      );
      vi.advanceTimersByTime(STORE_BATCH_MS);
    });
    expect(hasText(r.root, 'the job finished')).toBe(true);
  });

  it('does not ask twice when the screen opens on an already-connected socket', () => {
    // The everyday case — tapping a notification while the app is warm. The
    // screen's own request is the only one, and the chat must not be read
    // a second time from a different cursor: mobile's store folds a
    // re-delivered message and permission card by identity, but a re-delivered
    // tool call would be drawn twice.
    const ws = getWs();
    ws.connect();
    const sock = FakeWebSocket.last();
    actSync(() => {
      sock.emitOpen();
    });
    renderRN(<ChatDetailScreen />);
    expect(asksOn(sock)).toEqual([expect.objectContaining({ chatId: PUSHED_CHAT })]);
    expect(asksOn(sock)[0]).not.toHaveProperty('after');
  });
});
