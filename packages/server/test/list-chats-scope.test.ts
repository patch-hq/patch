// `patch.list_chats.request` scope (spec/03 § Cross-chat tools): finding a chat
// by name covers every chat that is not deleted, hidden and snoozed included.

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { ChatRegistry } from '../src/chat-registry.js';
import { ChatLogStore } from '../src/chat-log-store.js';
import { registerCrossHostBridge } from '../src/cross-host.js';
import { searchChats } from '../src/chat-search.js';
import type { HostLink } from '../src/host-link.js';
import type { Registry } from '../src/registry.js';
import type { ActivityReader } from '../src/activity.js';

const logger = pino({ level: 'silent' });
const NOW = 1_000_000;

function world() {
  const chatRegistry = new ChatRegistry({ logger, now: () => NOW });
  const add = (chatId: string, extra: Record<string, unknown>) => {
    chatRegistry.observe({
      type: 'chat.spawned',
      chatId,
      hostId: 'host-b',
      folder: '/w',
    } as WireEvent);
    chatRegistry.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId,
      name: `Chat ${chatId}`,
      activity: 'idle',
      lastUpdated: 1,
      folder: '/w',
      ...extra,
    } as WireEvent);
  };
  add('active', {});
  add('hidden', { hidden: true });
  add('snoozed', { snoozedUntil: NOW + 60_000 });
  add('archived', { status: 'archived' });
  add('deleted', { status: 'deleted' });
  return { chatRegistry, chatLogStore: new ChatLogStore({ logger }) };
}

function ask(scope?: 'archived' | 'all') {
  const w = world();
  const sent: WireEvent[] = [];
  let handler: ((e: WireEvent, from: string | null) => void) | undefined;
  const hostLink = {
    sendTo: (_h: string, _s: string, e: WireEvent) => sent.push(e),
    isOnline: () => true,
    onHostStatus: () => () => {},
    onEvent: (h: typeof handler) => {
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
  handler!(
    {
      type: 'patch.list_chats.request',
      sourceChatId: 'x',
      ...(scope ? { scope } : {}),
    } as WireEvent,
    'host-a',
  );
  const res = sent[0] as Extract<WireEvent, { type: 'patch.list_chats.response' }>;
  return { w, chats: res.chats };
}

describe('patch.list_chats.request scope', () => {
  it('scope all returns active, hidden, snoozed and archived, never deleted, each labelled', () => {
    const { chats } = ask('all');
    expect(chats.map((c) => c.chatId).sort()).toEqual(['active', 'archived', 'hidden', 'snoozed']);
    const by = (id: string) => chats.find((c) => c.chatId === id)!;
    expect(by('hidden')).toMatchObject({ hidden: true, snoozed: false, status: 'active' });
    expect(by('snoozed')).toMatchObject({ hidden: false, snoozed: true });
    expect(by('archived')).toMatchObject({ status: 'archived', hidden: false, snoozed: false });
    expect(by('active')).toMatchObject({ hidden: false, snoozed: false });
  });

  it('no scope lists current chats only; scope archived lists archived only', () => {
    expect(ask().chats.map((c) => c.chatId)).toEqual(['active']);
    expect(ask('archived').chats.map((c) => c.chatId)).toEqual(['archived']);
  });

  it('search covers hidden and snoozed chats and labels them', async () => {
    const { w } = ask();
    const { results } = await searchChats(w, 'chat');
    expect(results.map((r) => r.chatId).sort()).toEqual([
      'active',
      'archived',
      'hidden',
      'snoozed',
    ]);
    expect(results.find((r) => r.chatId === 'hidden')).toMatchObject({ hidden: true });
    expect(results.find((r) => r.chatId === 'snoozed')).toMatchObject({ snoozed: true });
  });
});
