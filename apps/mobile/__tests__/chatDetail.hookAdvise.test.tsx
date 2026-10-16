// app/chats/[chatId].tsx — the hook advise note under a sent message
// (spec/15 § Composer — Message hooks, spec/20-hooks.md § On the user's message).

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, actSync, findHost, queryHost, byTestId, hasText } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
    uploadAttachment: vi.fn(),
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

describe('hook advise note under a sent turn', () => {
  it('names the hook collapsed, and opens to its analysis on tap', () => {
    const s = useChatStore.getState();
    s.appendLocalUserMessage('c1', 'hello there', 'm-1');
    s.patchLocalMessage('c1', 'm-1', {
      hookAdvise: [{ hookId: 'h1', hookName: 'Nudge', analysis: 'a gentle thought' }],
    });
    const r = renderRN(<ChatDetailScreen />);
    const summary = findHost(r.root, byTestId('hook-advise-summary'));
    expect(hasText(summary, 'Nudge')).toBe(true);
    expect(hasText(r.root, 'a gentle thought')).toBe(false);
    actSync(() => summary.props.onPress());
    expect(hasText(findHost(r.root, byTestId('hook-advise-detail')), 'a gentle thought')).toBe(
      true,
    );
  });

  it('draws nothing for a turn with no advice', () => {
    useChatStore.getState().appendLocalUserMessage('c1', 'plain', 'm-2');
    const r = renderRN(<ChatDetailScreen />);
    expect(queryHost(r.root, byTestId('hook-advise-group'))).toBeNull();
  });
});
