import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../stores/chatStore.js';
import type { ChatRow } from '../stores/types.js';

const row = (chatId: string): ChatRow =>
  ({
    chatId,
    name: chatId,
    hostId: 'h',
    folder: 'f',
    status: 'active',
    chatStatus: { state: 'idle', since: 0 },
    lastUpdated: 1,
  }) as ChatRow;

const serverRow = (chatId: string) => ({
  chatId,
  name: chatId,
  hostId: 'h',
  folder: 'f',
  permissionMode: 'default' as const,
  chatStatus: { state: 'idle', since: 0 },
  status: 'active' as const,
  pinned: false,
  pinnedAt: null,
  disabled: false,
  lastUpdated: 2,
});

beforeEach(() => useChatStore.getState()._reset());

describe('device copy seeding', () => {
  it('shows the held rows, marked as a copy, before the server has answered', () => {
    useChatStore.getState().seedFromDeviceCopy([row('a'), row('b')]);
    const s = useChatStore.getState();
    expect(Object.keys(s.chats).sort()).toEqual(['a', 'b']);
    expect(s.deviceCopy).toBe(true);
    expect(s.hydrated).toBe(false);
  });

  it('is replaced, not merged, by the server list', () => {
    useChatStore.getState().seedFromDeviceCopy([row('a'), row('gone')]);
    useChatStore.getState().hydrate([serverRow('a')]);
    const s = useChatStore.getState();
    expect(Object.keys(s.chats)).toEqual(['a']);
    expect(s.deviceCopy).toBe(false);
    expect(s.hydrated).toBe(true);
  });

  it('never overwrites what the server has already said', () => {
    useChatStore.getState().hydrate([serverRow('a')]);
    useChatStore.getState().seedFromDeviceCopy([row('stale')]);
    expect(Object.keys(useChatStore.getState().chats)).toEqual(['a']);
    expect(useChatStore.getState().deviceCopy).toBe(false);
  });
});
