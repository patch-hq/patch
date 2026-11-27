// A special thread's current session (spec/06 § Bounded context) is mirrored
// from the host's chat.state so Settings → Manager → Context can show it.

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { ChatRegistry } from '../src/chat-registry.js';

const logger = pino({ level: 'silent' });

const state = (over: Record<string, unknown>): WireEvent =>
  ({
    type: 'chat.state',
    chatId: 'thread_manager',
    hostId: 'd1',
    activity: 'idle',
    permissionMode: 'auto',
    folder: '/m',
    lastUpdated: 0,
    ...over,
  }) as WireEvent;

describe('chat index — a special thread’s session', () => {
  it('keeps what the host last said, and an absent field means unchanged', () => {
    const chats = new ChatRegistry({ logger });
    chats.observe({ type: 'chat.spawned', chatId: 'thread_manager', hostId: 'd1', folder: '/m' });
    chats.observe(state({ session: { messages: 3, startedAt: 10 } }));
    expect(chats.get('thread_manager')?.session).toEqual({ messages: 3, startedAt: 10 });
    chats.observe(state({}));
    expect(chats.get('thread_manager')?.session).toEqual({ messages: 3, startedAt: 10 });
    chats.observe(state({ session: null }));
    expect(chats.get('thread_manager')?.session).toBeNull();
  });
});
