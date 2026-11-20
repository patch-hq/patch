// Background transcript sync (spec/12 § Offline reading, web variant): every
// roster chat's transcript is fetched in the background, one at a time, so
// opening a chat shows its messages at once rather than loading them on
// arrival. Regression for "Patch only loads new messages when you go to the
// chat".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PatchWs } from '../api/ws.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';

class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  readyState = 1;
  sent: string[] = [];
  listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
  constructor(public url: string) {
    FakeWS.instances.push(this);
    queueMicrotask(() => this.emit('open', {}));
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
  receive(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }
}

const row = (chatId: string, lastUpdated: number, over: Record<string, unknown> = {}) => ({
  chatId,
  hostId: 'h1',
  permissionMode: 'bypassPermissions' as const,
  name: chatId,
  folder: 'f',
  chatStatus: { state: 'idle', since: 0 },
  status: 'active' as const,
  pinned: false,
  pinnedAt: null,
  disabled: false,
  lastUpdated,
  ...over,
});

const msg = (chatId: string, seq: number) => ({
  type: 'chat.message',
  chatId,
  seq,
  role: 'assistant',
  content: `m${seq}`,
});

const replays = (fake: FakeWS): Array<{ chatId: string; fromSeq: number }> =>
  fake.sent
    .map((s) => JSON.parse(s) as { type: string; chatId: string; fromSeq: number })
    .filter((f) => f.type === 'chat.replay');

async function connect(): Promise<{ ws: PatchWs; fake: FakeWS }> {
  const ws = new PatchWs('ws://test/ws');
  ws.connect();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const fake = FakeWS.instances[FakeWS.instances.length - 1]!;
  fake.sent.length = 0;
  return { ws, fake };
}

beforeEach(() => {
  FakeWS.instances = [];
  (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
  vi.useFakeTimers();
  useChatStore.getState()._reset();
  usePresenceStore.setState({ hosts: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PatchWs.syncTranscripts', () => {
  it('fetches chats nobody has opened, one at a time, into the store', async () => {
    const { ws, fake } = await connect();
    useChatStore.getState().hydrate([row('c1', 1), row('c2', 2)]);
    ws.syncTranscripts();
    expect(replays(fake)).toEqual([
      { type: 'chat.replay', chatId: 'c1', fromSeq: -1, batch: true },
    ]);

    fake.receive({
      type: 'chat.replay_batch',
      chatId: 'c1',
      events: [msg('c1', 0), msg('c1', 1)],
      done: true,
    });
    vi.advanceTimersByTime(100);
    expect(useChatStore.getState().timelines['c1']?.length).toBe(2);
    expect(replays(fake).map((r) => r.chatId)).toEqual(['c1', 'c2']);
    ws.close();
  });

  it('does not fetch a chat again until its lastUpdated moves', async () => {
    const { ws, fake } = await connect();
    useChatStore.getState().hydrate([row('c1', 1)]);
    ws.syncTranscripts();
    fake.receive({ type: 'chat.replay_batch', chatId: 'c1', events: [msg('c1', 0)], done: true });
    fake.sent.length = 0;
    ws.syncTranscripts();
    expect(replays(fake)).toEqual([]);
    ws.close();
  });

  it('fetches only what is new when a chat changes after being synced', async () => {
    const { ws, fake } = await connect();
    useChatStore.getState().hydrate([row('c1', 1)]);
    ws.syncTranscripts();
    fake.receive({ type: 'chat.replay_batch', chatId: 'c1', events: [msg('c1', 0)], done: true });
    vi.advanceTimersByTime(100);
    fake.sent.length = 0;

    // Another surface talks to the chat: a live chat.state moves lastUpdated.
    fake.receive({
      type: 'chat.state',
      chatId: 'c1',
      hostId: 'h1',
      permissionMode: 'auto',
      chatStatus: { state: 'idle', since: 0 },
      lastUpdated: 5,
    });
    vi.advanceTimersByTime(1500);
    expect(replays(fake)).toEqual([{ type: 'chat.replay', chatId: 'c1', fromSeq: 0, batch: true }]);
    ws.close();
  });

  it('skips the open chat, running chats and chats on an offline host', async () => {
    const { ws, fake } = await connect();
    useChatStore
      .getState()
      .hydrate([
        row('open', 1),
        row('busy', 1, { chatStatus: { state: 'running', since: 0 } }),
        row('away', 1, { hostId: 'h2' }),
        row('ok', 1),
      ]);
    useChatStore.setState({ activeChatId: 'open' });
    usePresenceStore.setState({
      hosts: { h2: { online: false } } as never,
    });
    ws.syncTranscripts();
    expect(replays(fake).map((r) => r.chatId)).toEqual(['ok']);
    ws.close();
  });

  it('moves on from a host that never answers, and leaves the chat unsynced', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ws, fake } = await connect();
    useChatStore.getState().hydrate([row('c1', 1), row('c2', 1)]);
    ws.syncTranscripts();
    vi.advanceTimersByTime(30_000);
    expect(warn).toHaveBeenCalled();
    expect(replays(fake).map((r) => r.chatId)).toEqual(['c1', 'c2']);
    ws.close();
  });
});
