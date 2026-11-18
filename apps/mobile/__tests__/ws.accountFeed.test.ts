// The account feed and paged history on the phone (spec/05 § Loading, spec/03 §
// Chat history, § Account feed): against a server that runs the feed, the phone
// resumes it on connect, asks the server alone for history a page at a time,
// and fetches nothing chat by chat.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PatchWs, resetWs } from '../src/api/ws';
import { saveCredential, store } from '../src/lib/credential';
import { useChatStore } from '../src/stores/chatStore';
import { installFakeWebSocket, restoreWebSocket, FakeWebSocket } from './testUtils/fakeWebSocket';

const authOk = { type: 'auth.ok', accountId: 'a', surfaceId: 's', hosts: [], accountFeed: true };
const msg = (chatId: string, seq: number) => ({
  type: 'chat.message',
  chatId,
  seq,
  role: 'assistant',
  content: `m${seq}`,
});
const sent = (type: string): Array<Record<string, unknown>> =>
  FakeWebSocket.last()
    .sent.map((s) => JSON.parse(s as string) as Record<string, unknown>)
    .filter((f) => f['type'] === type);

function connect(): PatchWs {
  const ws = new PatchWs('ws://test/ws');
  ws.connect();
  FakeWebSocket.last().emitOpen();
  return ws;
}

beforeEach(() => {
  installFakeWebSocket();
  vi.useFakeTimers();
  saveCredential('a.b.c');
  store().delete('patch.feedPos');
  store().delete('patch.accountFeed');
  useChatStore.getState()._reset();
});

afterEach(() => {
  resetWs();
  vi.useRealTimers();
  restoreWebSocket();
});

describe('phone with the account feed', () => {
  it('resumes the feed on connect, following the chat on screen, and replays nothing', () => {
    // A phone that found the feed last time it connected.
    store().set('patch.accountFeed', '1');
    useChatStore.setState({ activeChatId: 'c1' });
    const ws = connect();
    FakeWebSocket.last().emitMessage(JSON.stringify(authOk));
    const [resume] = sent('feed.resume');
    expect(resume).toBeDefined();
    expect(resume!['after']).toBeUndefined();
    expect(sent('chat.replay')).toEqual([]);
    ws.close();
  });

  it('opens a chat on its last screen and pages older entries into record order', () => {
    const ws = connect();
    FakeWebSocket.last().emitMessage(JSON.stringify(authOk));
    ws.requestReplay('c1');
    const [ask] = sent('chat.history_request');
    expect(ask).toMatchObject({ chatId: 'c1', limit: 100 });
    FakeWebSocket.last().emitMessage(
      JSON.stringify({
        type: 'chat.history',
        requestId: ask!['requestId'],
        chatId: 'c1',
        entries: [msg('c1', 8), msg('c1', 9)],
        more: true,
        through: 9,
        pending: [],
        queued: [],
      }),
    );
    expect(useChatStore.getState().historyMore['c1']).toBe(true);
    ws.loadEarlier('c1');
    const older = sent('chat.history_request')[1];
    expect(older).toMatchObject({ chatId: 'c1', before: 8 });
    FakeWebSocket.last().emitMessage(
      JSON.stringify({
        type: 'chat.history',
        requestId: older!['requestId'],
        chatId: 'c1',
        entries: [msg('c1', 6), msg('c1', 7)],
        more: false,
        through: 9,
        pending: [],
        queued: [],
      }),
    );
    expect(useChatStore.getState().timelines['c1']?.map((e) => e.seq)).toEqual([6, 7, 8, 9]);
    expect(useChatStore.getState().historyMore['c1']).toBe(false);
    ws.close();
  });

  it('tells the server with feed.follow when a chat it did not follow is opened, and not otherwise', () => {
    const ws = connect();
    FakeWebSocket.last().emitMessage(JSON.stringify(authOk));
    const [resume] = sent('feed.resume');
    expect(resume!['follow']).toEqual([]);

    // Opening a chat changes what the phone follows.
    useChatStore.setState({ activeChatId: 'c7' });
    vi.advanceTimersByTime(400);
    const follows = sent('feed.follow');
    expect(follows).toHaveLength(1);
    expect(follows[0]!['follow']).toEqual([{ chatId: 'c7', after: -1 }]);

    // A store change that leaves the set as it was sends nothing.
    useChatStore.setState({ activeChatId: 'c7', timelines: {} });
    vi.advanceTimersByTime(400);
    expect(sent('feed.follow')).toHaveLength(1);

    // Leaving it drops it from the set.
    useChatStore.setState({ activeChatId: null });
    vi.advanceTimersByTime(400);
    expect(sent('feed.follow')[1]!['follow']).toEqual([]);
    ws.close();
  });

  it('sends no feed.follow to a server without the feed', () => {
    const ws = connect();
    FakeWebSocket.last().emitMessage(JSON.stringify({ ...authOk, accountFeed: false }));
    useChatStore.setState({ activeChatId: 'c7' });
    vi.advanceTimersByTime(400);
    expect(sent('feed.follow')).toEqual([]);
    ws.close();
  });

  it('takes a followed chat it held nothing of as its last screen, and asks for it itself when opened later', () => {
    useChatStore.setState({
      activeChatId: 'c1',
      chats: {
        c2: {
          chatId: 'c2',
          name: 'c2',
          hostId: 'h',
          folder: '/f',
          activity: 'idle',
          permissionMode: 'auto',
          status: 'active',
          pinned: false,
          pinnedAt: null,
          lastUpdated: 5,
          pendingWake: null,
          snoozedUntil: null,
        } as never,
      },
    });
    const ws = connect();
    FakeWebSocket.last().emitMessage(JSON.stringify(authOk));
    const [resume] = sent('feed.resume');
    expect(resume!['follow']).toEqual([
      { chatId: 'c1', after: -1 },
      { chatId: 'c2', after: -1 },
    ]);
    // The server answers the open chat with its last screen; older pages remain.
    FakeWebSocket.last().emitMessage(
      JSON.stringify({
        type: 'chat.history',
        requestId: 'feed.last',
        chatId: 'c1',
        entries: [msg('c1', 98), msg('c1', 99)],
        more: true,
        through: 99,
        pending: [],
        queued: [],
      }),
    );
    expect(useChatStore.getState().timelines['c1']?.map((e) => e.seq)).toEqual([98, 99]);
    expect(useChatStore.getState().historyMore['c1']).toBe(true);
    // Forward catch-up is not asked for: the last screen is already the end.
    expect(sent('chat.history_request')).toEqual([]);
    // The open chat was answered by the feed: asking again is only for what
    // follows its last screen…
    ws.requestReplay('c1');
    expect(sent('chat.history_request')).toEqual([
      expect.objectContaining({ chatId: 'c1', after: 99 }),
    ]);
    // …while a followed chat whose answer went only to the offline copy asks
    // for its own last screen when opened.
    ws.requestReplay('c2');
    expect(sent('chat.history_request')[1]).toEqual(
      expect.objectContaining({ chatId: 'c2', limit: 100 }),
    );
    expect(sent('chat.history_request')[1]!['after']).toBeUndefined();
    ws.close();
  });

  it('keeps the feed position it is sent', () => {
    const ws = connect();
    FakeWebSocket.last().emitMessage(JSON.stringify(authOk));
    FakeWebSocket.last().emitMessage(
      JSON.stringify({
        type: 'feed.reset',
        feedPos: 21,
      }),
    );
    expect(store().getString('patch.feedPos')).toBe('21');
    ws.close();
  });
});
