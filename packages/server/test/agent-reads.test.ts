// `patch_peek` / `patch_history` answered by the server (spec/03 § Cross-chat
// tools): from its own record and chat status, for a chat on any host, online
// or not. No host is ever asked.

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { chatHistory, peekChat, stripBinaryPayloads } from '../src/agent-reads.js';
import { ChatLogStore } from '../src/chat-log-store.js';
import { ChatRegistry } from '../src/chat-registry.js';
import { registerCrossHostBridge } from '../src/cross-host.js';
import type { HostLink } from '../src/host-link.js';
import type { Registry } from '../src/registry.js';
import type { ActivityReader } from '../src/activity.js';

const logger = pino({ level: 'silent' });

function world(messages = 5) {
  const chatRegistry = new ChatRegistry();
  const chatLogStore = new ChatLogStore({ logger });
  chatRegistry.observe({
    type: 'chat.spawned',
    chatId: 'c1',
    hostId: 'host-b',
    folder: '/work/c1',
  } as WireEvent);
  for (let seq = 0; seq < messages; seq++) {
    chatLogStore.commit({
      type: 'chat.message',
      chatId: 'c1',
      seq,
      role: seq % 2 === 0 ? 'user' : 'assistant',
      content: `m${seq}`,
      createdAt: 1000 + seq,
    } as WireEvent);
  }
  const online = new Set<string>();
  return {
    chatRegistry,
    chatLogStore,
    online,
    deps: { chatRegistry, chatLogStore, isHostOnline: (h: string) => online.has(h) },
  };
}

describe('a patch_agent subagent', () => {
  function withChild() {
    const w = world();
    w.chatLogStore.noteParent('kid', 'c1');
    w.chatLogStore.commit({
      type: 'chat.message',
      chatId: 'kid',
      seq: 0,
      role: 'assistant',
      content: 'ok',
      createdAt: 2000,
    } as WireEvent);
    return w;
  }

  it('peeks through its parent even though it is not in the registry', () => {
    const out = peekChat(withChild().deps, 'kid');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.chat_state).toMatchObject({
      chatId: 'kid',
      subagentOf: 'c1',
      hostId: 'host-b',
      lastMessage: 'ok',
    });
  });

  it('reads its history', () => {
    const out = chatHistory(withChild().deps, 'kid');
    expect(out.ok).toBe(true);
  });

  it('is still not found when its parent is unknown', () => {
    const w = world();
    w.chatLogStore.noteParent('orphan', 'nope');
    expect(peekChat(w.deps, 'orphan').ok).toBe(false);
  });
});

describe('peekChat', () => {
  it('returns the server status and the latest entries for a chat whose host is offline', () => {
    const w = world();
    const out = peekChat(w.deps, 'c1', 2);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.chat_state).toMatchObject({
      chatId: 'c1',
      hostId: 'host-b',
      hostOnline: false,
      folder: '/work/c1',
      status: 'active',
      lastMessage: 'm3',
      eventCount: 5,
    });
    expect(out.result.chat_state.chatStatus).toMatchObject({ state: 'idle' });
    // The latest messages from the whole track, not just the returned slice.
    expect(out.result.chat_state.lastMessages).toEqual([
      { role: 'user', content: 'm0', seq: 0, ts: 1000 },
      { role: 'assistant', content: 'm1', seq: 1, ts: 1001 },
      { role: 'user', content: 'm2', seq: 2, ts: 1002 },
      { role: 'assistant', content: 'm3', seq: 3, ts: 1003 },
      { role: 'user', content: 'm4', seq: 4, ts: 1004 },
    ]);
    expect('activity' in out.result.chat_state).toBe(false);
    expect(out.result.events.map((e) => (e as { content: string }).content)).toEqual(['m3', 'm4']);
    expect(out.result.truncated).toBe(true);
  });

  it('keeps only the latest 20 messages', () => {
    const w = world(30);
    const out = peekChat(w.deps, 'c1', 1);
    const last = out.ok ? (out.result.chat_state.lastMessages as { seq: number }[]) : [];
    expect(last).toHaveLength(20);
    expect(last[0]!.seq).toBe(10);
    expect(last.at(-1)!.seq).toBe(29);
  });

  it('says not truncated when the whole record fits', () => {
    const w = world(3);
    w.online.add('host-b');
    const out = peekChat(w.deps, 'c1');
    expect(out.ok && out.result.truncated).toBe(false);
    expect(out.ok && out.result.chat_state.hostOnline).toBe(true);
  });

  it('refuses a chat the server does not know', () => {
    const w = world();
    expect(peekChat(w.deps, 'nope')).toEqual({
      ok: false,
      error: { code: 'chat_not_found', message: 'no such chat: nope' },
    });
  });
});

describe('chatHistory', () => {
  it('pages forward from a seq, with nextFromSeq while more remain', () => {
    const w = world();
    const first = chatHistory(w.deps, 'c1', undefined, 2);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.result.events.map((e) => (e as { seq: number }).seq)).toEqual([0, 1]);
    expect(first.result.nextFromSeq).toBe(2);
    const last = chatHistory(w.deps, 'c1', 4, 2);
    expect(last.ok && last.result.events.map((e) => (e as { seq: number }).seq)).toEqual([4]);
    expect(last.ok && last.result.nextFromSeq).toBeUndefined();
  });

  it('clamps the limit to 200 rather than refusing', () => {
    const w = world(250);
    const out = chatHistory(w.deps, 'c1', 0, 5000);
    expect(out.ok && out.result.events).toHaveLength(200);
  });
});

describe('stripBinaryPayloads', () => {
  it('replaces base64 images and truncates huge strings', () => {
    const out = stripBinaryPayloads({
      a: {
        type: 'image',
        source: { type: 'base64', data: 'x'.repeat(100), media_type: 'image/png' },
      },
      b: 'y'.repeat(9000),
    });
    expect(out.a).toEqual({ type: 'image', omitted: '[image/png omitted, 100 base64 chars]' });
    expect(out.b).toMatch(/…\[truncated 1000 chars\]$/);
  });
});

describe('the cross-host bridge answers peek/history itself', () => {
  function bridge() {
    const w = world();
    const sent: { hostId: string; event: WireEvent }[] = [];
    let handler: ((e: WireEvent, from: string | null) => void) | undefined;
    const hostLink = {
      sendTo: (hostId: string, _s: string, event: WireEvent) => sent.push({ hostId, event }),
      isOnline: (id: string) => w.online.has(id),
      onEvent: (h: (e: WireEvent, from: string | null) => void) => {
        handler = h;
        return () => undefined;
      },
    } as unknown as HostLink;
    registerCrossHostBridge({
      logger,
      hostLink,
      chatRegistry: w.chatRegistry,
      registry: { isRegisteredHost: () => true } as unknown as Registry,
      activity: {} as ActivityReader,
      chatLogStore: w.chatLogStore,
    });
    return { sent, feed: (e: WireEvent, from: string | null) => handler?.(e, from) };
  }

  it('answers the asking host, never relaying to the owner (which is offline here)', () => {
    const b = bridge();
    b.feed(
      {
        type: 'patch.peek.request',
        sourceChatId: 'src',
        targetChatId: 'c1',
        requestId: 'r1',
        limit: 1,
      } as WireEvent,
      'host-a',
    );
    expect(b.sent).toHaveLength(1);
    expect(b.sent[0]!.hostId).toBe('host-a');
    expect(b.sent[0]!.event).toMatchObject({
      type: 'patch.peek.response',
      requestId: 'r1',
      ok: true,
      result: { truncated: true, chat_state: { chatId: 'c1' } },
    });
  });

  it('answers patch_history the same way, and refuses an unknown chat', () => {
    const b = bridge();
    b.feed(
      {
        type: 'patch.history.request',
        sourceChatId: 'src',
        targetChatId: 'c1',
        requestId: 'h1',
        fromSeq: 3,
      } as WireEvent,
      'host-a',
    );
    b.feed(
      {
        type: 'patch.history.request',
        sourceChatId: 'src',
        targetChatId: 'missing',
        requestId: 'h2',
      } as WireEvent,
      'host-a',
    );
    expect(b.sent[0]!.event).toMatchObject({
      type: 'patch.history.response',
      requestId: 'h1',
      ok: true,
      result: { events: [{ seq: 3 }, { seq: 4 }] },
    });
    expect(b.sent[1]!.event).toMatchObject({
      type: 'patch.history.response',
      requestId: 'h2',
      ok: false,
      error: { code: 'chat_not_found' },
    });
  });

  it('lists chats with the server’s own status (patch_list_chats, the CLI lists)', () => {
    const b = bridge();
    b.feed({ type: 'patch.list_chats.request', sourceChatId: 'cli' } as WireEvent, 'host-a');
    const reply = b.sent.find((x) => x.event.type === 'patch.list_chats.response')!.event as {
      chats: Array<{ chatId: string; chatStatus?: { state: string } }>;
    };
    expect(reply.chats.find((c) => c.chatId === 'c1')?.chatStatus).toMatchObject({
      state: 'idle',
    });
  });

  it('does not answer an older host’s audit record (no requestId)', () => {
    const b = bridge();
    b.feed(
      { type: 'patch.peek.request', sourceChatId: 'src', targetChatId: 'c1' } as WireEvent,
      'host-a',
    );
    expect(b.sent).toEqual([]);
  });
});
