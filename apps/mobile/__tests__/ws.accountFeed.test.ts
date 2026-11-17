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
