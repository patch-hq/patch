// The account feed and paged history (spec/05 § Loading, spec/03 § Chat
// history, § Account feed): against a server that runs the feed, the surface
// resumes it on connect, asks the server alone for history a page at a time,
// and never replays chat by chat.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PatchWs, CHAT_INDEX_STALE_EVENT } from '../api/ws.js';
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
  activity: 'idle' as const,
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

const frames = (fake: FakeWS, type: string): Array<Record<string, unknown>> =>
  fake.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((f) => f['type'] === type);

const authOk = { type: 'auth.ok', accountId: 'a', surfaceId: 's', hosts: [], accountFeed: true };

describe('PatchWs with the account feed', () => {
  beforeEach(() => window.localStorage.removeItem('patch.feedPos'));

  it('resumes the feed on connect with the chats it holds, and asks for no replays', async () => {
    const { ws, fake } = await connect();
    useChatStore.getState().hydrate([row('c1', 1), row('c2', 2)]);
    useChatStore.getState().applyEvents([msg('c1', 0), msg('c1', 4)] as never);
    window.localStorage.setItem('patch.feedPos', '7');
    fake.receive(authOk);
    expect(frames(fake, 'feed.resume')).toEqual([
      { type: 'feed.resume', after: 7, follow: [{ chatId: 'c1', after: 4 }] },
    ]);
    ws.syncTranscripts();
    vi.advanceTimersByTime(2000);
    expect(frames(fake, 'chat.replay')).toEqual([]);
    ws.close();
  });

  it('opens a chat on its last screen, then pages older entries as asked', async () => {
    const { ws, fake } = await connect();
    fake.receive(authOk);
    useChatStore.getState().hydrate([row('c1', 1)]);
    ws.requestReplay('c1');
    const [ask] = frames(fake, 'chat.history_request');
    expect(ask).toMatchObject({ chatId: 'c1', limit: 100 });
    expect(ask).not.toHaveProperty('after');
    fake.receive({
      type: 'chat.history',
      requestId: ask!['requestId'],
      chatId: 'c1',
      entries: [msg('c1', 8), msg('c1', 9)],
      more: true,
      through: 9,
      pending: [],
      queued: [],
    });
    vi.advanceTimersByTime(100);
    const st = useChatStore.getState();
    expect(st.timelines['c1']?.map((e) => e.seq)).toEqual([8, 9]);
    expect(st.historyMore['c1']).toBe(true);
    expect(st.replaying['c1']).toBeUndefined();

    ws.loadEarlier('c1');
    const older = frames(fake, 'chat.history_request')[1];
    expect(older).toMatchObject({ chatId: 'c1', before: 8 });
    fake.receive({
      type: 'chat.history',
      requestId: older!['requestId'],
      chatId: 'c1',
      entries: [msg('c1', 6), msg('c1', 7)],
      more: false,
      through: 9,
      pending: [],
      queued: [],
    });
    vi.advanceTimersByTime(100);
    expect(useChatStore.getState().timelines['c1']?.map((e) => e.seq)).toEqual([6, 7, 8, 9]);
    expect(useChatStore.getState().historyMore['c1']).toBe(false);
    ws.close();
  });

  it('keeps the feed position it is sent, and reloads the index on a reset', async () => {
    const { ws, fake } = await connect();
    fake.receive(authOk);
    useChatStore.getState().hydrate([row('c1', 1)]);
    fake.receive({
      type: 'chat.state',
      chatId: 'c1',
      hostId: 'h1',
      permissionMode: 'auto',
      activity: 'idle',
      lastUpdated: 2,
      feedPos: 12,
    });
    expect(window.localStorage.getItem('patch.feedPos')).toBe('12');
    let reloads = 0;
    const onStale = (): void => void (reloads += 1);
    window.addEventListener(CHAT_INDEX_STALE_EVENT, onStale);
    fake.receive({ type: 'feed.reset', feedPos: 30 });
    window.removeEventListener(CHAT_INDEX_STALE_EVENT, onStale);
    expect(reloads).toBe(1);
    expect(window.localStorage.getItem('patch.feedPos')).toBe('30');
    ws.close();
  });

  it('an older server, with no feed, still gets replays', async () => {
    const { ws, fake } = await connect();
    fake.receive({ ...authOk, accountFeed: undefined });
    useChatStore.getState().hydrate([row('c1', 1)]);
    ws.requestReplay('c1');
    expect(frames(fake, 'chat.replay')).toHaveLength(1);
    expect(frames(fake, 'chat.history_request')).toEqual([]);
    ws.close();
  });
});
