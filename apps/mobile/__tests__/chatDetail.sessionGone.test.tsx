// app/chats/[chatId].tsx — spec/04 § Resume: a chat whose provider session is
// gone says plainly where the model's memory ends, and offers Start a linked
// chat, which drafts one on the same model and opens it. Parity with web.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  hasText,
  flush,
  actAsync,
} from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __resetRouterMock, __setLocalSearchParams, routerMock } from './stubs/expo-router';

const { continueSpy } = vi.hoisted(() => ({ continueSpy: vi.fn() }));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestHistory: vi.fn() }),
}));
vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
    continueChat: continueSpy,
  },
  ApiError: class ApiError extends Error {},
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

const GONE = "The model's memory of this chat ends here: its session is no longer on this host.";
let ChatDetailScreen: React.ComponentType;

const seed = (extra: Record<string, unknown> = {}): void => {
  useChatStore.getState()._reset();
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'My Chat',
      folder: '~/project',
      chatStatus: { state: 'idle', since: 0 },
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
      ...extra,
    } as never,
  ]);
  useChatStore.getState().applyEvent({
    type: 'chat.message',
    chatId: 'c1',
    role: 'system',
    content: GONE,
    sessionGone: true,
    seq: 2,
  } as never);
};

beforeEach(async () => {
  vi.clearAllMocks();
  __resetRouterMock();
  continueSpy.mockResolvedValue({
    draft: {
      id: 'draft-linked-m2',
      hostId: 'd1',
      folder: '~/project',
      text: 'This continues "My Chat"',
      continuedFrom: 'c1',
      updatedAt: 1,
    },
  });
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setHost('online');
  ChatDetailScreen = (await import('../app/chats/[chatId]')).default;
  __setLocalSearchParams({ chatId: 'c1' });
});

describe('a provider session that is gone', () => {
  it('says where the memory ends, and Start a linked chat opens the drafted chat', async () => {
    seed();
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(findHost(r.root, byTestId('session-gone')), GONE)).toBe(true);
    await actAsync(async () => {
      (findHost(r.root, byTestId('session-gone-linked-chat')).props.onPress as () => void)();
      await flush();
    });
    expect(continueSpy).toHaveBeenCalledWith('c1', {});
    expect(routerMock.push).toHaveBeenCalledWith('/new-chat?draftId=draft-linked-m2');
  });

  it('a chat already continued offers no second linked chat', () => {
    seed({ continuedIn: 'c2' });
    const r = renderRN(<ChatDetailScreen />);
    expect(queryHost(r.root, byTestId('session-gone'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('session-gone-linked-chat'))).toBeNull();
  });
});
