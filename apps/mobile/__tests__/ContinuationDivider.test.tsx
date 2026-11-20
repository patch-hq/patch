// spec/04 § Provider switches — linked chats read as one thread: the newer chat
// opens with a divider naming the chat it continues and what changed, the older
// one ends with a divider naming its continuation, and each opens the other.

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderRN, findHost, queryHost, byTestId, hasText, actSync } from './testUtils/render';
import { ContinuationDivider, continuationChange } from '../src/components/ContinuationDivider';
import { useChatStore } from '../src/stores/chatStore';
import { __resetRouterMock, routerMock } from './stubs/expo-router';

const base = {
  folder: '/w',
  chatStatus: { state: 'idle', since: 0 },
  status: 'active' as const,
  pinned: false,
  pinnedAt: null,
  lastUpdated: 1,
  permissionMode: 'default' as const,
};

beforeEach(() => {
  __resetRouterMock();
  useChatStore.getState()._reset();
  useChatStore.getState().hydrate([
    {
      ...base,
      chatId: 'old',
      hostId: 'd1',
      name: 'Plan',
      model: 'claude-opus-5-5',
      continuedIn: 'new',
    },
    {
      ...base,
      chatId: 'new',
      hostId: 'd1',
      name: 'Plan again',
      model: 'openai/gpt-5',
      continuedFrom: 'old',
    },
    { ...base, chatId: 'solo', hostId: 'd1', name: 'Solo', model: 'claude-opus-5-5' },
  ]);
});

describe('ContinuationDivider', () => {
  it('opens the newer chat naming the one it continues and the switch, and taps through to it', () => {
    const r = renderRN(<ContinuationDivider chatId="new" edge="start" />);
    const link = findHost(r.root, byTestId('continuation-start-link'));
    expect(hasText(link, 'Continued from ')).toBe(true);
    expect(hasText(link, 'Plan')).toBe(true);
    expect(hasText(link, ' · Opus 5.5 → openai/gpt-5')).toBe(true);
    actSync(() => (link.props.onPress as () => void)());
    expect(routerMock.push).toHaveBeenCalledWith('/chats/old');
  });

  it('ends the older chat naming the one that continues it', () => {
    const r = renderRN(<ContinuationDivider chatId="old" edge="end" />);
    expect(hasText(findHost(r.root, byTestId('continuation-end-link')), 'Plan again')).toBe(true);
  });

  it('draws nothing on a chat with no link', () => {
    const r = renderRN(<ContinuationDivider chatId="solo" edge="start" />);
    expect(queryHost(r.root, byTestId('continuation-start'))).toBeNull();
  });

  it('names the hosts for a move', () => {
    expect(
      continuationChange({ hostId: 'a', model: 'm' }, { hostId: 'b', model: 'm' }, (h) =>
        h.toUpperCase(),
      ),
    ).toBe('A → B');
  });
});
