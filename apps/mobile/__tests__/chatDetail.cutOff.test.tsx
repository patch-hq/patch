// app/chats/[chatId].tsx — spec/12 § Continue: the line where a restart cut a
// turn off carries Continue while the server says the chat is Interrupted, and
// pressing it sends `chat.continue_request`. Parity with web's ChatRoute test.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, findHost, queryHost, byTestId } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams } from './stubs/expo-router';

const sendMock = vi.fn();
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: sendMock, safeSend: vi.fn(), requestHistory: vi.fn() }),
}));
vi.mock('../src/api/rest', () => ({
  api: {
    getChatArtifacts: vi.fn(async () => ({ artifacts: [] })),
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
  },
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;

const seed = (state: string): void => {
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
      chatStatus: { state, since: 1 },
    } as never,
  ]);
  useChatStore.getState().applyEvent({
    type: 'chat.message',
    chatId: 'c1',
    role: 'system',
    content: 'Turn interrupted by restart',
    seq: 2,
    createdAt: 2,
  } as never);
};

beforeEach(async () => {
  vi.clearAllMocks();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setHost('online');
  const mod = await import('../app/chats/[chatId]');
  ChatDetailScreen = mod.default;
  __setLocalSearchParams({ chatId: 'c1' });
});

describe('interrupted line', () => {
  it('offers Continue while Interrupted and sends chat.continue_request', () => {
    seed('interrupted');
    const r = renderRN(<ChatDetailScreen />);
    expect(findHost(r.root, byTestId('turn-cut-off'))).toBeTruthy();
    findHost(r.root, byTestId('turn-cut-off-continue')).props.onPress();
    expect(sendMock).toHaveBeenCalledWith({ type: 'chat.continue_request', chatId: 'c1' });
  });

  it('keeps the line but drops Continue once the chat is no longer Interrupted', () => {
    seed('running');
    const r = renderRN(<ChatDetailScreen />);
    expect(findHost(r.root, byTestId('turn-cut-off'))).toBeTruthy();
    expect(queryHost(r.root, byTestId('turn-cut-off-continue'))).toBeNull();
  });
});
