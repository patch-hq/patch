// Account-wide chat listing and search through the server (spec/06 § Cross-chat
// toolset — `patch_list_chats`, `patch_search_chats`).

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { registerCrossHostBridge } from '../src/cross-host.js';
import { ChatLogStore } from '../src/chat-log-store.js';
import { searchChats } from '../src/chat-search.js';
import type { HostLink } from '../src/host-link.js';
import type { ChatRegistry } from '../src/chat-registry.js';
import type { Registry } from '../src/registry.js';

const logger = pino({ level: 'silent' });

const chat = (chatId: string, hostId: string, extra: Record<string, unknown> = {}) => ({
  chatId,
  hostId,
  name: null,
  preview: null,
  folder: '/work',
  status: 'active',
  activity: 'idle',
  pinned: false,
  pinnedAt: null,
  lastUpdated: 100,
  statusSummary: null,
  ...extra,
});

const msg = (chatId: string, seq: number, role: 'user' | 'assistant', content: string) =>
  ({ type: 'chat.message', chatId, seq, role, content }) as WireEvent;

function setup() {
  const chats = [
    chat('c-local', 'host-a', { name: 'Deploy pipeline', lastUpdated: 300 }),
    chat('c-remote', 'host-b', { name: 'Garden', folder: '/home/garden', lastUpdated: 200 }),
    chat('c-nolog', 'host-b', { name: 'Old', statusSummary: 'waiting on deploy approval' }),
  ];
  const chatRegistry = { list: () => chats, get: () => undefined } as unknown as ChatRegistry;
  const store = new ChatLogStore({ logger });
  store.commit(msg('c-remote', 1, 'user', 'can you check the DEPLOY of the greenhouse sensors?'));
  store.commit(msg('c-remote', 2, 'assistant', 'nothing relevant here'));
  store.commit(msg('c-local', 1, 'user', 'hello'));
  return { chatRegistry, store };
}

describe('searchChats', () => {
  it('finds by name, summary and message text across hosts, name matches first', () => {
    const { chatRegistry, store } = setup();
    const r = searchChats({ chatRegistry, chatLogStore: store }, 'deploy');
    expect(r.results.map((x) => x.chatId)).toEqual(['c-local', 'c-nolog', 'c-remote']);
    expect(r.results[2]).toMatchObject({
      hostId: 'host-b',
      matchedIn: ['messages'],
      excerpts: [{ seq: 1, role: 'user' }],
    });
    expect(r.results[2]!.excerpts[0]!.text).toContain('DEPLOY');
  });

  it('says how many chats were searched by metadata only', () => {
    const { chatRegistry, store } = setup();
    expect(searchChats({ chatRegistry, chatLogStore: store }, 'zzz')).toEqual({
      results: [],
      truncated: false,
      chatsWithoutLog: 1,
    });
  });

  it('truncates to the limit and reports it', () => {
    const { chatRegistry, store } = setup();
    const r = searchChats({ chatRegistry, chatLogStore: store }, 'deploy', 1);
    expect(r.results).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });
});

describe('cross-host bridge: listing and search', () => {
  function bridge() {
    const { chatRegistry, store } = setup();
    const sent: Array<{ hostId: string; event: WireEvent }> = [];
    let handler: ((e: WireEvent, from: string | null) => void) | undefined;
    const hostLink = {
      sendTo: (hostId: string, _s: string, event: WireEvent) => sent.push({ hostId, event }),
      isOnline: () => true,
      onEvent: (h: typeof handler) => {
        handler = h;
        return () => undefined;
      },
    } as unknown as HostLink;
    registerCrossHostBridge({
      logger,
      hostLink,
      chatRegistry,
      registry: { isRegisteredHost: () => true } as unknown as Registry,
      chatLogStore: store,
    } as never);
    return { sent, feed: (e: WireEvent, from: string | null) => handler?.(e, from) };
  }

  it('list_chats names every chat with its name, folder and status, whatever its host', () => {
    const b = bridge();
    b.feed({ type: 'patch.list_chats.request', sourceChatId: 'x' } as WireEvent, 'host-a');
    const res = b.sent[0]!.event as Extract<WireEvent, { type: 'patch.list_chats.response' }>;
    expect(res.chats.find((c) => c.chatId === 'c-remote')).toMatchObject({
      hostId: 'host-b',
      name: 'Garden',
      folder: '/home/garden',
      status: 'active',
      activity: 'idle',
    });
  });

  it('answers a search request to the asking machine', () => {
    const b = bridge();
    b.feed(
      { type: 'patch.search_chats.request', sourceChatId: 'x', query: 'greenhouse' } as WireEvent,
      'host-a',
    );
    expect(b.sent[0]!.hostId).toBe('host-a');
    expect(b.sent[0]!.event).toMatchObject({
      type: 'patch.search_chats.response',
      sourceChatId: 'x',
      query: 'greenhouse',
      results: [{ chatId: 'c-remote', hostId: 'host-b' }],
    });
  });
});
