// Chats tab header — the Drafts button (spec/14 § New chat drafts, spec/15 §
// New chat flow): the phone's entry point to the full Drafts list, parity
// with desktop's sidebar section. Pins:
//   - hidden with no drafts (or only blank ones)
//   - shown with a count once a draft has real text, and opens /drafts

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderRN, findHost, findAllHost, byTestId } from './testUtils/render';
import ChatsScreen from '../app/(tabs)/chats';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useNewChatDraftStore } from '../src/stores/newChatDraftStore';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import { __clearAllMmkv } from './stubs/mmkv';

vi.mock('../src/lib/voiceNote', () => ({
  startVoiceNote: vi.fn(),
  releaseVoiceNoteIfHeld: vi.fn(),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));
vi.mock('../src/api/rest', () => ({
  api: {
    chatSectionCounts: vi
      .fn()
      .mockResolvedValue({ archived: 0, snoozed: 0, hidden: 0, deleted: 0, automations: 0 }),
    listArchivedChats: vi.fn().mockResolvedValue({ chats: [] }),
    listHiddenChats: vi.fn().mockResolvedValue({ chats: [] }),
  },
}));

beforeEach(() => {
  __clearAllMmkv();
  useChatStore.getState()._reset();
  usePresenceStore.setState({
    connection: 'connecting',
    daemon: 'unknown',
    accountId: null,
    surfaceId: null,
  });
  useNewChatDraftStore.getState()._reset();
  __resetRouterMock();
});

describe('ChatsScreen — header Drafts button', () => {
  it('is hidden with no drafts', () => {
    const r = renderRN(<ChatsScreen />);
    expect(findAllHost(r.root, byTestId('chats-drafts-button'))).toHaveLength(0);
  });

  it('stays hidden for a blank (never-typed-into) draft', () => {
    useNewChatDraftStore.getState().create('/f');
    const r = renderRN(<ChatsScreen />);
    expect(findAllHost(r.root, byTestId('chats-drafts-button'))).toHaveLength(0);
  });

  it('shows a count once a draft has text, and opens /drafts', () => {
    const id = useNewChatDraftStore.getState().create('/f');
    useNewChatDraftStore.getState().update(id, { text: 'hello' });
    const r = renderRN(<ChatsScreen />);
    const btn = findHost(r.root, byTestId('chats-drafts-button'));
    expect(btn.props.accessibilityLabel).toBe('Drafts (1)');
    btn.props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith('/drafts');
  });
});
