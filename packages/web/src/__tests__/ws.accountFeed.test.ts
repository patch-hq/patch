// The account feed and paged history (spec/05 § Loading, spec/03 § Chat
// history, § Account feed): against a server that runs the feed, the surface
// resumes it on connect, asks the server alone for history a page at a time,
// and never replays chat by chat.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PatchWs, CHAT_INDEX_STALE_EVENT, FEED_RECENT_CHATS, FOLLOW_SYNC_MS } from '../api/ws.js';
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

  it('resumes the feed on connect with the chats it holds, and asks for nothing chat by chat', async () => {
    const { ws, fake } = await connect();
    useChatStore.getState().hydrate([row('c1', 1), row('c2', 2)]);
    useChatStore.getState().applyEvents([msg('c1', 0), msg('c1', 4)] as never);
    window.localStorage.setItem('patch.feedPos', '7');
    fake.receive(authOk);
    expect(frames(fake, 'feed.resume')).toEqual([
      { type: 'feed.resume', after: 7, follow: [{ chatId: 'c1', after: 4 }] },
    ]);
    expect(frames(fake, 'chat.history_request')).toEqual([]);
    ws.close();
  });

  it('opens a chat on its last screen, then pages older entries as asked', async () => {
    const { ws, fake } = await connect();
    fake.receive(authOk);
    useChatStore.getState().hydrate([row('c1', 1)]);
    ws.requestHistory('c1');
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

  it('takes a followed chat it held nothing of as its last screen, with older pages above', async () => {
    const { ws, fake } = await connect();
    useChatStore.getState().hydrate([row('c1', 1)]);
    useChatStore.getState().setActiveChat('c1');
    fake.receive(authOk);
    expect(frames(fake, 'feed.resume')[0]!['follow']).toEqual([{ chatId: 'c1', after: -1 }]);
    fake.receive({
      type: 'chat.history',
      requestId: 'feed.last',
      chatId: 'c1',
      entries: [msg('c1', 98), msg('c1', 99)],
      more: true,
      through: 99,
      pending: [],
      queued: [],
    });
    vi.advanceTimersByTime(100);
    const st = useChatStore.getState();
    expect(st.timelines['c1']?.map((e) => e.seq)).toEqual([98, 99]);
    expect(st.historyMore['c1']).toBe(true);
    // `more` runs backwards here: no forward catch-up is asked for.
    expect(frames(fake, 'chat.history_request').filter((f) => f['after'] !== undefined)).toEqual(
      [],
    );
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
      chatStatus: { state: 'idle', since: 0 },
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
});

// A chat that comes into the list while the surface is connected — unarchived
// on another device, or new — is followed at once, so its entries arrive live
// without its being opened (spec/03 § Account feed: a device sends feed.follow
// whenever its set changes).
describe('PatchWs follows chats as they come into the list', () => {
  beforeEach(() => window.localStorage.removeItem('patch.feedPos'));

  // As the server sends it: an entry of its chat index, with its feed position.
  const state = (chatId: string, status: string, lastUpdated = 5) => ({
    type: 'chat.state',
    ...row(chatId, lastUpdated, { status }),
    feedPos: lastUpdated,
  });
  const settle = (): void => {
    vi.advanceTimersByTime(FOLLOW_SYNC_MS + 50);
  };

  it('follows a chat unarchived on another device, and drops it if it is archived again', async () => {
    const { ws, fake } = await connect();
    useChatStore.getState().hydrate([row('c1', 1)]);
    fake.receive(authOk);
    expect(frames(fake, 'feed.resume')[0]!['follow']).toEqual([]);

    fake.receive(state('c-back', 'active'));
    settle();
    expect(frames(fake, 'feed.follow')).toEqual([
      { type: 'feed.follow', follow: [{ chatId: 'c-back', after: -1 }] },
    ]);

    // A later frame for it changes nothing.
    fake.receive(state('c-back', 'active', 6));
    settle();
    expect(frames(fake, 'feed.follow')).toHaveLength(1);

    fake.receive(state('c-back', 'archived', 7));
    settle();
    expect(frames(fake, 'feed.follow')[1]).toEqual({ type: 'feed.follow', follow: [] });
    ws.close();
  });

  it('follows a chat listed as archived that comes back, and a chat new to the account', async () => {
    const { ws, fake } = await connect();
    useChatStore.getState().hydrate([row('c-old', 1, { status: 'archived' })]);
    fake.receive(authOk);
    fake.receive(state('c-old', 'active'));
    fake.receive({ type: 'chat.spawned', chatId: 'c-new', hostId: 'h1', folder: 'f' });
    fake.receive(state('c-new', 'active', 8));
    settle();
    const [follow] = frames(fake, 'feed.follow');
    expect((follow!['follow'] as Array<{ chatId: string }>).map((f) => f.chatId).sort()).toEqual([
      'c-new',
      'c-old',
    ]);
    ws.close();
  });

  it('follows the chat opened, and sends nothing when the set is unchanged or before the resume', async () => {
    const { ws, fake } = await connect();
    useChatStore.getState().hydrate([row('c1', 1)]);
    // Before the feed is resumed there is no set to change.
    useChatStore.getState().setActiveChat('c1');
    settle();
    expect(frames(fake, 'feed.follow')).toEqual([]);
    fake.receive(authOk);
    expect(frames(fake, 'feed.resume')[0]!['follow']).toEqual([{ chatId: 'c1', after: -1 }]);
    useChatStore.getState().hydrate([row('c1', 2)]);
    settle();
    expect(frames(fake, 'feed.follow')).toEqual([]);
    useChatStore.getState().setActiveChat(null);
    settle();
    expect(frames(fake, 'feed.follow')).toEqual([{ type: 'feed.follow', follow: [] }]);
    ws.close();
  });

  it('keeps the newest arrivals only, and holds back while the socket is not open', async () => {
    const { ws, fake } = await connect();
    fake.receive(authOk);
    for (let i = 0; i <= FEED_RECENT_CHATS; i++) fake.receive(state(`n${i}`, 'active', 10 + i));
    settle();
    const ids = (frames(fake, 'feed.follow')[0]!['follow'] as Array<{ chatId: string }>).map(
      (f) => f.chatId,
    );
    expect(ids).toHaveLength(FEED_RECENT_CHATS);
    expect(ids).not.toContain('n0');
    fake.readyState = 3;
    fake.receive(state('late', 'active', 99));
    settle();
    expect(frames(fake, 'feed.follow')).toHaveLength(1);
    ws.close();
  });

  it('close() stops a pending follow check', async () => {
    const { ws, fake } = await connect();
    fake.receive(authOk);
    fake.receive(state('c-back', 'active'));
    ws.close();
    settle();
    expect(frames(fake, 'feed.follow')).toEqual([]);
  });
});
