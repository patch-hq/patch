// The reply to one delivered message, read from the server's record
// (`patch.reply.request`, spec/03 § Cross-chat tools). The Manager call waits on
// it for a chat on any host: the asking host and the chat's host differ here.

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { replyFromRecord } from '../src/reply-from-record.js';
import { peekChat } from '../src/agent-reads.js';
import { ChatLogStore } from '../src/chat-log-store.js';
import { ChatRegistry } from '../src/chat-registry.js';
import { registerCrossHostBridge } from '../src/cross-host.js';
import type { HostLink } from '../src/host-link.js';
import type { Registry } from '../src/registry.js';
import type { ActivityReader } from '../src/activity.js';

const logger = pino({ level: 'silent' });

const msg = (seq: number, role: 'user' | 'assistant', content: string, localId?: string) =>
  ({
    type: 'chat.message',
    chatId: 'c-laptop',
    seq,
    role,
    content,
    createdAt: 1000 + seq,
    ...(localId !== undefined ? { localId } : {}),
  }) as WireEvent;

const turn = (
  kind: 'started' | 'ended',
  turnId: string,
  seq: number,
  outcome: 'completed' | 'failed' = 'completed',
) =>
  (kind === 'started'
    ? { type: 'chat.turn_started', chatId: 'c-laptop', turnId, seq, at: seq }
    : {
        type: 'chat.turn_ended',
        chatId: 'c-laptop',
        turnId,
        seq,
        at: seq,
        outcome,
        ...(outcome === 'failed' ? { error: { code: 'sdk_error', message: 'rate limited' } } : {}),
      }) as WireEvent;

describe('replyFromRecord', () => {
  it('waits until the message is in the record and its turn has ended', () => {
    const store = new ChatLogStore({ logger });
    expect(replyFromRecord(store, 'c-laptop', 'L1')).toEqual({ state: 'waiting' });
    store.commit(turn('started', 't1', -1));
    store.commit(msg(0, 'user', 'run the tests', 'L1'));
    store.commit(msg(1, 'assistant', 'Running them now.'));
    expect(replyFromRecord(store, 'c-laptop', 'L1')).toEqual({ state: 'waiting' });
    store.commit(msg(2, 'assistant', 'All 212 pass.'));
    store.commit(turn('ended', 't1', 2));
    expect(replyFromRecord(store, 'c-laptop', 'L1')).toEqual({
      state: 'answered',
      text: 'Running them now.\nAll 212 pass.',
    });
  });

  it('a chat busy when the message came: only what it said after taking it is the reply', () => {
    const store = new ChatLogStore({ logger });
    store.commit(turn('started', 't0', -1));
    store.commit(msg(0, 'user', 'earlier work'));
    store.commit(msg(1, 'assistant', 'the earlier answer'));
    store.commit(turn('ended', 't0', 1));
    store.commit(turn('started', 't1', 1));
    store.commit(msg(2, 'user', 'run the tests', 'L1'));
    store.commit(msg(3, 'assistant', '[voice • phone] on it'));
    store.commit(msg(4, 'assistant', 'All 212 pass.'));
    store.commit(turn('ended', 't1', 4));
    store.commit(msg(5, 'assistant', 'a later turn'));
    expect(replyFromRecord(store, 'c-laptop', 'L1')).toEqual({
      state: 'answered',
      text: 'All 212 pass.',
    });
  });

  it('a failed turn, or an error naming the message, is a failure', () => {
    const failedTurn = new ChatLogStore({ logger });
    failedTurn.commit(msg(0, 'user', 'x', 'L1'));
    failedTurn.commit(turn('ended', 't1', 0, 'failed'));
    expect(replyFromRecord(failedTurn, 'c-laptop', 'L1')).toEqual({
      state: 'failed',
      message: 'rate limited',
    });

    const errored = new ChatLogStore({ logger });
    errored.commit(msg(0, 'user', 'x', 'L1'));
    errored.commit({
      type: 'chat.error',
      chatId: 'c-laptop',
      seq: 1,
      causeSeq: 0,
      error: { code: 'sdk_error', message: 'not signed in' },
    } as WireEvent);
    expect(replyFromRecord(errored, 'c-laptop', 'L1')).toEqual({
      state: 'failed',
      message: 'not signed in',
    });
  });
});

describe('the cross-host bridge answers patch.reply.request from its record', () => {
  function world() {
    const chatRegistry = new ChatRegistry();
    const chatLogStore = new ChatLogStore({ logger });
    // The chat lives on host-b; the Manager asking is on host-a.
    chatRegistry.observe({
      type: 'chat.spawned',
      chatId: 'c-laptop',
      hostId: 'host-b',
      folder: '/work/build',
    } as WireEvent);
    const sent: { hostId: string; event: WireEvent }[] = [];
    let onEvent: ((e: WireEvent, from: string | null) => void) | undefined;
    let onHostStatus: ((id: string, s: 'online' | 'offline') => void) | undefined;
    const hostLink = {
      sendTo: (hostId: string, _s: string, event: WireEvent) => sent.push({ hostId, event }),
      isOnline: () => true,
      onHostStatus: (h: typeof onHostStatus) => {
        onHostStatus = h;
        return () => undefined;
      },
      onEvent: (h: typeof onEvent) => {
        onEvent = h;
        return () => undefined;
      },
    } as unknown as HostLink;
    registerCrossHostBridge({
      logger,
      hostLink,
      chatRegistry,
      registry: { isRegisteredHost: () => true } as unknown as Registry,
      activity: {} as ActivityReader,
      chatLogStore,
    });
    // As the server takes a host's event: into the record, then every handler.
    const fromHostB = (e: WireEvent) => {
      chatLogStore.commit(e);
      onEvent!(e, 'host-b');
    };
    const ask = (requestId: string, localId: string, targetChatId = 'c-laptop') =>
      onEvent!(
        {
          type: 'patch.reply.request',
          requestId,
          sourceChatId: 'thread_manager',
          targetChatId,
          localId,
        } as WireEvent,
        'host-a',
      );
    const tick = () => new Promise((r) => setImmediate(r));
    return { sent, fromHostB, ask, tick, chatRegistry, chatLogStore, offline: onHostStatus! };
  }

  it('a reply already in the record is answered at once, to the asking host', () => {
    const w = world();
    w.fromHostB(msg(0, 'user', 'run the tests', 'L1'));
    w.fromHostB(msg(1, 'assistant', 'All 212 pass.'));
    w.fromHostB(turn('ended', 't1', 1));
    w.ask('r1', 'L1');
    expect(w.sent).toEqual([
      {
        hostId: 'host-a',
        event: {
          type: 'patch.reply.response',
          requestId: 'r1',
          sourceChatId: 'thread_manager',
          targetChatId: 'c-laptop',
          ok: true,
          result: { text: 'All 212 pass.' },
        },
      },
    ]);
  });

  it('a reply still to come is pushed back when the chat host reports the turn ending', async () => {
    const w = world();
    w.ask('r1', 'L1');
    w.fromHostB(msg(0, 'user', 'run the tests', 'L1'));
    w.fromHostB(msg(1, 'assistant', 'All 212 pass.'));
    await w.tick();
    expect(w.sent).toEqual([]);
    w.fromHostB(turn('ended', 't1', 1));
    await w.tick();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({
      hostId: 'host-a',
      event: { type: 'patch.reply.response', requestId: 'r1', ok: true },
    });
    expect((w.sent[0]!.event as { result: { text: string } }).result.text).toBe('All 212 pass.');
    // Answered once.
    w.fromHostB(msg(2, 'assistant', 'more'));
    await w.tick();
    expect(w.sent).toHaveLength(1);
  });

  it('a failed turn comes back as a failure', async () => {
    const w = world();
    w.ask('r1', 'L1');
    w.fromHostB(msg(0, 'user', 'x', 'L1'));
    w.fromHostB(turn('ended', 't1', 0, 'failed'));
    await w.tick();
    expect(w.sent[0]!.event).toMatchObject({
      type: 'patch.reply.response',
      ok: false,
      error: { message: 'rate limited' },
    });
  });

  it('a chat the server does not know is refused at once', () => {
    const w = world();
    w.ask('r1', 'L1', 'nope');
    expect(w.sent[0]!.event).toMatchObject({
      type: 'patch.reply.response',
      requestId: 'r1',
      ok: false,
      error: { code: 'chat_not_found' },
    });
  });

  it('an asking host that goes offline is forgotten: nothing is sent to it later', async () => {
    const w = world();
    w.ask('r1', 'L1');
    w.offline('host-a', 'offline');
    w.fromHostB(msg(0, 'user', 'x', 'L1'));
    w.fromHostB(turn('ended', 't1', 0));
    await w.tick();
    expect(w.sent).toEqual([]);
  });
});

describe('patch_peek carries where a chat says it stands', () => {
  it('its status line, goal and to-dos, for a chat on any host', () => {
    const chatRegistry = new ChatRegistry();
    const chatLogStore = new ChatLogStore({ logger });
    chatRegistry.observe({
      type: 'chat.spawned',
      chatId: 'c-laptop',
      hostId: 'host-b',
      folder: '/work/build',
    } as WireEvent);
    chatRegistry.observe({
      type: 'chat.state',
      chatId: 'c-laptop',
      seq: 1,
      ts: 0,
      activity: 'idle',
      statusSummary: 'Tests green',
      goal: 'Ship the build',
      todos: [{ text: 'tag the release', status: 'pending' }],
    } as WireEvent);
    chatLogStore.commit(msg(0, 'assistant', 'All 212 pass.'));
    const out = peekChat({ chatRegistry, chatLogStore, isHostOnline: () => false }, 'c-laptop', 1);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.chat_state).toMatchObject({
      hostId: 'host-b',
      statusSummary: 'Tests green',
      goal: 'Ship the build',
      todos: [{ text: 'tag the release', status: 'pending' }],
      lastMessages: [{ role: 'assistant', content: 'All 212 pass.' }],
    });
  });
});
