// app/chats/[chatId].tsx — while an opened chat's transcript is still on its
// way the empty area says it is loading, not "No messages yet".

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, actSync } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: { markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })) },
}));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

beforeEach(() => {
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

describe('empty chat while its transcript loads', () => {
  it('says Loading… while replaying, then No messages yet once the replay is over', async () => {
    const Screen = (await import('../app/chats/[chatId]')).default;
    actSync(() => useChatStore.getState().setReplaying('c1', true));
    const view = renderRN(<Screen />);
    expect(JSON.stringify(view.toJSON())).toContain('Loading…');
    expect(JSON.stringify(view.toJSON())).not.toContain('No messages yet');
    actSync(() => useChatStore.getState().setReplaying('c1', false));
    expect(JSON.stringify(view.toJSON())).toContain('No messages yet');
  });
});

describe('opening a chat does not raise the keyboard', () => {
  it('renders the composer input without autoFocus', async () => {
    const Screen = (await import('../app/chats/[chatId]')).default;
    const view = renderRN(<Screen />);
    const inputs = view.root.findAll((n) => typeof n.type === 'string' && n.type === 'TextInput');
    expect(inputs.length).toBeGreaterThan(0);
    for (const i of inputs) expect(i.props['autoFocus']).toBeFalsy();
  });
});
