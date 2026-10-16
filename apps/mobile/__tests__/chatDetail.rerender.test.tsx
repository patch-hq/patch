// app/chats/[chatId].tsx — a store commit that touches nothing this chat shows
// must not re-render the chat screen. Every message row carries a side-thread
// marker; a marker that subscribes to a whole store map re-renders every row on
// each streamed event anywhere (the "mobile app has become very slow" report).

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, actSync } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
  },
}));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;

beforeEach(async () => {
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setHost('online');
  ChatDetailScreen = (await import('../app/chats/[chatId]')).default;
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
});

describe('chat screen re-renders', () => {
  it("another chat's side-thread permission change re-renders no message row", () => {
    for (let seq = 1; seq <= 5; seq++) {
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'c1',
        seq,
        role: 'assistant',
        content: `message ${seq}`,
      });
    }
    let commits = 0;
    renderRN(
      <React.Profiler id="chat" onRender={() => commits++}>
        <ChatDetailScreen />
      </React.Profiler>,
    );
    commits = 0;
    actSync(() => {
      useChatStore.setState({ sideThreadPermissions: { 'other::b1': [] } });
    });
    expect(commits).toBe(0);
  });
});
