// app/chats/[chatId].tsx — the Manager's header carries a settings gear that
// opens Settings → Manager (spec/15 § Voice tab (Manager)); no other chat has it.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { renderRN, findHost, queryHost, byLabel, byTestId, actSync } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams, routerMock } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: {
    getChatArtifacts: vi.fn(async () => ({ artifacts: [] })),
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
  },
}));
const wsMock = { send: vi.fn(), safeSend: vi.fn(), requestHistory: vi.fn() };
vi.mock('../src/api/ws', () => ({ getWs: () => wsMock }));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;

beforeEach(async () => {
  vi.clearAllMocks();
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setHost('online');
  ChatDetailScreen = (await import('../app/chats/[chatId]')).default;
});

function seed(chatId: string): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      name: 'Chat',
      hostId: 'd1',
      folder: '~/p',
      chatStatus: { state: 'idle', since: 0 },
      permissionMode: 'default',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
}

describe('chat-detail — Manager settings gear', () => {
  it('a regular chat has no gear', () => {
    seed('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    expect(queryHost(r.root, byTestId('chat-manager-settings'))).toBeNull();
  });

  it('the Manager’s gear opens Settings → Manager', () => {
    seed(SPECIAL_THREAD_IDS.manager);
    __setLocalSearchParams({ chatId: SPECIAL_THREAD_IDS.manager });
    const r = renderRN(<ChatDetailScreen />);
    const gear = findHost(r.root, byLabel('Manager settings'));
    actSync(() => gear.props.onPress());
    expect(routerMock.push).toHaveBeenCalledWith('/settings/manager');
  });
});
