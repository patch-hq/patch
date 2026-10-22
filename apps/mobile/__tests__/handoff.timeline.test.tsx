// spec/04 § Handoff budget on the phone — the provider-switch divider, the
// error's three recoveries, and the linked-chat row.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, findHost, findAllHost, byTestId, hasText } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams, routerMock } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: { markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })) },
}));
const sendMock = vi.fn();
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: sendMock, safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;

beforeEach(async () => {
  vi.clearAllMocks();
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setHost('online');
  ChatDetailScreen = (await import('../app/chats/[chatId]')).default;
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'Long chat',
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

const DIVIDER = 'Handed off to openai/gpt-6-astra — carried 120 of 4,100 entries';

describe('handoff on mobile', () => {
  it('the divider shows the host wording as one line of furniture', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 5,
      role: 'system',
      content: DIVIDER,
      sessionChange: {
        harness: 'codex',
        model: 'openai/gpt-6-astra',
        seededMessages: 120,
        handoff: {
          carriedEntries: 120,
          totalEntries: 4100,
          omittedFromSeq: 0,
          omittedToSeq: 3979,
          estimatedTokens: 38000,
          availableTokens: 190000,
          summary: false,
        },
      },
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(findHost(r.root, byTestId('handoff-divider'))).toBeTruthy();
    expect(hasText(r.root, DIVIDER)).toBe(true);
  });

  it.each([
    ['handoff-retry', 'retry'],
    ['handoff-switch-back', 'switch_back'],
    ['handoff-linked-chat', 'linked_chat'],
  ])('a handoff error offers %s, which sends the recovery frame', (testId, action) => {
    useChatStore.getState().applyEvent({
      type: 'chat.error',
      chatId: 'c1',
      seq: 6,
      error: { code: 'handoff_overflow', message: 'Too large even after re-planning.' },
    });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byTestId(testId))!.props.onPress();
    expect(sendMock).toHaveBeenCalledWith({
      type: 'chat.handoff_recover_request',
      chatId: 'c1',
      action,
    });
  });

  it('an ordinary error offers none of them', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.error',
      chatId: 'c1',
      seq: 6,
      error: { code: 'no_model_catalogue', message: 'nope' },
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('handoff-retry'))).toHaveLength(0);
  });

  it('the linked-chat row opens the new chat', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 7,
      role: 'system',
      content: 'Continued in a linked fresh chat',
      handoffLink: { chatId: 'c2' },
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(findHost(r.root, byTestId('handoff-link'))).toBeTruthy();
    const label = findAllHost(
      r.root,
      (i) => i.type === 'Text' && typeof i.props['onPress'] === 'function',
    ).find((t) => hasText(t, 'Continued in a linked fresh chat'))!;
    label.props['onPress']();
    expect(routerMock.push).toHaveBeenCalledWith('/chats/c2');
  });
});
