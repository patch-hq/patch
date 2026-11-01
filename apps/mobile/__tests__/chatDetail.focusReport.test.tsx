// app/chats/[chatId].tsx — spec/09 § `### push`: the open chat is reported to
// the server (chat.focus_change) so a notification about any other chat still
// reaches the phone; leaving the chat, or backgrounding the app, clears it.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppState } from 'react-native';
import { actSync, renderRN } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams } from './stubs/expo-router';

const send = vi.fn();
vi.mock('../src/api/rest', () => ({
  api: { markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })) },
}));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: send, requestReplay: vi.fn() }),
}));

let ChatDetailScreen: React.ComponentType;

beforeEach(async () => {
  send.mockClear();
  (AppState as { currentState: string }).currentState = 'active';
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setHost('online');
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'My Chat',
      folder: '~/project',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
  __setLocalSearchParams({ chatId: 'c1' });
  ChatDetailScreen = (await import('../app/chats/[chatId]')).default;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chat detail — focus report', () => {
  it('reports the chat on open and clears it on leaving', () => {
    const r = renderRN(<ChatDetailScreen />);
    expect(send).toHaveBeenCalledWith({ type: 'chat.focus_change', chatId: 'c1' });
    actSync(() => r.unmount());
    expect(send).toHaveBeenLastCalledWith({ type: 'chat.focus_change', chatId: null });
  });

  it('clears the focus when the app is backgrounded and restores it on return', () => {
    let listener: ((s: string) => void) | undefined;
    vi.spyOn(AppState, 'addEventListener').mockImplementation(((
      _t: string,
      l: (s: string) => void,
    ) => {
      listener = l;
      return { remove: vi.fn() };
    }) as never);
    const r = renderRN(<ChatDetailScreen />);
    actSync(() => listener?.('background'));
    expect(send).toHaveBeenLastCalledWith({ type: 'chat.focus_change', chatId: null });
    actSync(() => listener?.('active'));
    expect(send).toHaveBeenLastCalledWith({ type: 'chat.focus_change', chatId: 'c1' });
    actSync(() => r.unmount());
  });
});
