// Composer — context ring (spec/14 § Composer — context ring, mirrored on the phone).
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { findHost, queryHost, byTestId, hasText, renderRN, actSync } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import { __clearAllMmkv } from './stubs/mmkv';

vi.mock('../src/api/rest', () => ({
  api: { skills: vi.fn().mockResolvedValue({ skills: [] }), uploadAttachment: vi.fn() },
}));

import { Composer } from '../src/components/Composer';

const row = {
  chatId: 'c1',
  name: 'x',
  folder: 'work',
  activity: 'idle' as const,
  status: 'active' as const,
  pinned: false,
  pinnedAt: null,
  lastUpdated: 1,
};

beforeEach(() => {
  __clearAllMmkv();
  __resetRouterMock();
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  useChatStore.getState()._reset();
});

describe('context ring', () => {
  it('is absent until the host has measured the chat', () => {
    useChatStore.getState().hydrate([row]);
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    expect(queryHost(r.root, byTestId('context-ring'))).toBeNull();
  });

  it('shows the percentage and opens a sheet with the figures and a way to Usage', () => {
    useChatStore
      .getState()
      .hydrate([{ ...row, context: { usedTokens: 84_000, windowTokens: 200_000, at: 1 } }]);
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const ring = findHost(r.root, byTestId('context-ring'));
    expect(ring.props['accessibilityLabel']).toBe('Context 42%');
    actSync(() => ring.props['onPress']());
    expect(hasText(findHost(r.root, byTestId('context-sheet-figures')), '42% · 84k / 200k')).toBe(
      true,
    );
    actSync(() => findHost(r.root, byTestId('context-sheet-usage')).props['onPress']());
    expect(routerMock.push).toHaveBeenCalledWith('/settings/usage');
    expect(queryHost(r.root, byTestId('context-sheet'))).toBeNull();
  });

  it('follows a chat.state event, and Close and the backdrop dismiss', () => {
    useChatStore.getState().hydrate([row]);
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    actSync(() =>
      useChatStore.getState().applyEvent({
        type: 'chat.state',
        chatId: 'c1',
        activity: 'idle',
        context: { usedTokens: 95_000, windowTokens: 100_000, at: 2 },
      } as never),
    );
    const ring = findHost(r.root, byTestId('context-ring'));
    expect(ring.props['accessibilityLabel']).toBe('Context 95%');
    actSync(() => ring.props['onPress']());
    actSync(() => findHost(r.root, byTestId('context-sheet-close')).props['onPress']());
    expect(queryHost(r.root, byTestId('context-sheet'))).toBeNull();
    actSync(() => ring.props['onPress']());
    actSync(() => findHost(r.root, byTestId('context-sheet-backdrop')).props['onPress']());
    expect(queryHost(r.root, byTestId('context-sheet'))).toBeNull();
  });

  it('a chat.state without a context keeps the known reading; an explicit null clears it', () => {
    useChatStore
      .getState()
      .hydrate([{ ...row, context: { usedTokens: 10, windowTokens: 100, at: 1 } }]);
    const apply = (e: object) =>
      useChatStore.getState().applyEvent({ type: 'chat.state', chatId: 'c1', ...e } as never);
    apply({ activity: 'running' });
    expect(useChatStore.getState().chats['c1']!.context).not.toBeNull();
    apply({ activity: 'idle', context: null });
    expect(useChatStore.getState().chats['c1']!.context).toBeNull();
  });
});
