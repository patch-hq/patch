// app/chats/[chatId].tsx — the call strip is pinned at the app shell
// (CallStrip), so the chat itself carries no call panel or pill.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { actSync, byTestId, queryHost, renderRN } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useVoiceStore } from '../src/stores/voiceStore';
import { __setLocalSearchParams } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
  },
}));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({
  startVoiceCall: vi.fn(),
  endVoiceCall: vi.fn(),
  retryVoiceCall: vi.fn(),
  setCallMode: vi.fn(),
  setCallMuted: vi.fn(),
}));

let ChatDetailScreen: React.ComponentType;
const mounted: ReturnType<typeof renderRN>[] = [];

beforeEach(async () => {
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
  useVoiceStore.setState({ activeSession: null, callError: null });
  const mod = await import('../app/chats/[chatId]');
  ChatDetailScreen = mod.default;
});

afterEach(() => {
  for (const r of mounted.splice(0)) actSync(() => r.unmount());
  useVoiceStore.setState({ activeSession: null });
});

function open(): ReturnType<typeof renderRN> {
  const r = renderRN(<ChatDetailScreen />);
  mounted.push(r);
  return r;
}

function callOn(chatId: string): void {
  useVoiceStore.setState({
    activeSession: { sessionId: 's', chatId, audioUrl: '/a', startedAt: 0 },
    callPhase: 'listening',
    callMode: 'call',
    callConnectedAt: 0,
  });
}

describe('chat detail — no docked call panel', () => {
  it.each([['c1'], ['thread_manager']])(
    'a call on %s leaves no bar or pill in the chat: the strip is the app shell’s',
    (chatId) => {
      callOn(chatId);
      const r = open();
      expect(queryHost(r.root, byTestId('call-bar'))).toBeNull();
      expect(queryHost(r.root, byTestId('call-pill'))).toBeNull();
    },
  );
});
