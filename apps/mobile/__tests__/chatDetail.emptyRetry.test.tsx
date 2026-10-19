// app/chats/[chatId].tsx — a replay lost around a host restart must not leave
// an opened chat on "No messages yet": while the timeline is empty the screen
// asks again, forced, with backoff.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderRN, actSync } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: { markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })) },
}));
const requestReplay = vi.fn();
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestReplay }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setHost('online');
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'My Chat',
      folder: '~/p',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
  __setLocalSearchParams({ chatId: 'c1' });
});
afterEach(() => vi.useRealTimers());

describe('empty chat on open', () => {
  it('asks for the transcript again, forced, while nothing has arrived', async () => {
    const Screen = (await import('../app/chats/[chatId]')).default;
    renderRN(<Screen />);
    expect(requestReplay).toHaveBeenCalledTimes(1);
    actSync(() => vi.advanceTimersByTime(3000));
    expect(requestReplay).toHaveBeenCalledTimes(2);
    expect(requestReplay).toHaveBeenLastCalledWith('c1', { force: true });
  });

  it('stops asking once a message arrives', async () => {
    const Screen = (await import('../app/chats/[chatId]')).default;
    renderRN(<Screen />);
    actSync(() =>
      useChatStore
        .getState()
        .applyEvent({ type: 'chat.message', chatId: 'c1', seq: 0, role: 'user', content: 'hi' }),
    );
    actSync(() => vi.advanceTimersByTime(60000));
    expect(requestReplay).toHaveBeenCalledTimes(1);
  });
});
