// Offline reading (spec/12 § Offline reading): every chat in the roster is
// brought onto the phone, one replay at a time, straight into the cache.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getWs, resetWs } from '../src/api/ws';
import { saveCredential } from '../src/lib/credential';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { installFakeWebSocket, restoreWebSocket, FakeWebSocket } from './testUtils/fakeWebSocket';
import { __clearAllMmkv } from './stubs/mmkv';
import {
  __resetPendingForTests,
  heldCursor,
  loadTranscript,
  saveEvents,
} from '../src/lib/transcriptCache';

const row = (chatId: string, lastUpdated: number, hostId = 'h1') => ({
  chatId,
  hostId,
  name: chatId,
  folder: '~/x',
  activity: 'idle' as const,
  status: 'active' as const,
  pinned: false,
  pinnedAt: null,
  lastUpdated,
});

const ev = (chatId: string, seq: number): unknown => ({
  type: 'chat.message',
  chatId,
  seq,
  role: 'assistant',
  content: `m${seq}`,
});

beforeEach(() => {
  installFakeWebSocket();
  vi.useFakeTimers();
  __clearAllMmkv();
  __resetPendingForTests();
  saveCredential('a.b.c');
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  usePresenceStore.setState({ hosts: {} });
});

afterEach(() => {
  resetWs();
  vi.useRealTimers();
  restoreWebSocket();
  vi.restoreAllMocks();
});

function open(): FakeWebSocket {
  getWs().connect();
  const sock = FakeWebSocket.last();
  sock.emitOpen();
  sock.sent.length = 0;
  return sock;
}

const replays = (sock: FakeWebSocket): Array<{ chatId: string; fromSeq: number }> =>
  sock.sent.map((s) => JSON.parse(s as string)).filter((m) => m.type === 'chat.replay');

describe('syncTranscripts', () => {
  it('fetches uncached chats one at a time, into the cache and not the store', () => {
    useChatStore.getState().hydrate([row('c1', 1), row('c2', 2)]);
    const sock = open();
    getWs().syncTranscripts();
    expect(replays(sock)).toEqual([
      { type: 'chat.replay', chatId: 'c1', fromSeq: -1, batch: true },
    ]);

    sock.emitMessage(
      JSON.stringify({
        type: 'chat.replay_batch',
        chatId: 'c1',
        events: [ev('c1', 0), ev('c1', 1)],
        done: true,
      }),
    );
    vi.advanceTimersByTime(1000);
    expect(heldCursor('c1')).toBe(1);
    expect(useChatStore.getState().timelines['c1'] ?? []).toEqual([]);
    expect(replays(sock).map((r) => r.chatId)).toEqual(['c1', 'c2']);
  });

  it('asks only for what is newer than the held copy, and not at all once level', () => {
    saveEvents('c1', [ev('c1', 0), ev('c1', 1), ev('c1', 2)]);
    vi.advanceTimersByTime(1000);
    useChatStore.getState().hydrate([row('c1', 5)]);
    const sock = open();
    getWs().syncTranscripts();
    expect(replays(sock)[0]).toMatchObject({ chatId: 'c1', fromSeq: 2 });
    sock.emitMessage(
      JSON.stringify({
        type: 'chat.replay_batch',
        chatId: 'c1',
        events: [ev('c1', 3)],
        done: true,
      }),
    );
    vi.advanceTimersByTime(1000);
    sock.sent.length = 0;
    getWs().syncTranscripts();
    expect(replays(sock)).toEqual([]);
  });

  it('skips chats on an offline host and chats removed from the roster are dropped', () => {
    saveEvents('gone', [ev('gone', 0)]);
    vi.advanceTimersByTime(1000);
    usePresenceStore.setState({
      hosts: { h2: { hostId: 'h2', online: false } as never },
    });
    useChatStore.getState().hydrate([row('c1', 1, 'h2')]);
    const sock = open();
    getWs().syncTranscripts();
    expect(replays(sock)).toEqual([]);
    expect(loadTranscript('gone')).toBeNull();
  });

  it('an opened chat takes over from the background fetch', () => {
    useChatStore.getState().hydrate([row('c1', 1)]);
    const sock = open();
    getWs().syncTranscripts();
    getWs().requestReplay('c1');
    sock.emitMessage(
      JSON.stringify({
        type: 'chat.replay_batch',
        chatId: 'c1',
        events: [ev('c1', 0)],
        done: true,
      }),
    );
    vi.advanceTimersByTime(20);
    expect(useChatStore.getState().timelines['c1']?.length).toBe(1);
  });

  it('reports a host that never answers instead of waiting for ever', () => {
    useChatStore.getState().hydrate([row('c1', 1)]);
    open();
    getWs().syncTranscripts();
    vi.advanceTimersByTime(31_000);
    expect(
      useUiStore
        .getState()
        .errors.map((e) => e.message)
        .join(' '),
    ).toMatch(/offline copy of chat c1 timed out/);
  });
});
