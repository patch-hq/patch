// Chats tab header — the Archived button: one tap from the top of the list
// opens the (otherwise collapsed, bottom-of-list) Archived section and scrolls
// to its header.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderRN,
  findHost,
  findAllHost,
  byTestId,
  byLabel,
  actSync,
  actAsync,
} from './testUtils/render';
import ChatsScreen from '../app/(tabs)/chats';
import { useChatStore } from '../src/stores/chatStore';
import { __clearAllMmkv } from './stubs/mmkv';
import { __resetRouterMock } from './stubs/expo-router';
import { getSectionOpen } from '../src/lib/sectionCollapse';

vi.mock('../src/lib/voiceNote', () => ({
  startVoiceNote: vi.fn(),
  releaseVoiceNoteIfHeld: vi.fn(),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));
vi.mock('../src/api/rest', () => ({
  api: {
    chatSectionCounts: vi
      .fn()
      .mockResolvedValue({ archived: 2, snoozed: 0, hidden: 0, deleted: 0, automations: 0 }),
    listArchivedChats: vi.fn().mockResolvedValue({ chats: [], nextCursor: null }),
    listHiddenChats: vi.fn().mockResolvedValue({ chats: [] }),
    searchChats: vi.fn().mockResolvedValue({ hits: [], hosts: [] }),
  },
}));

beforeEach(() => {
  __clearAllMmkv();
  useChatStore.getState()._reset();
  __resetRouterMock();
});

describe('ChatsScreen — header Archived button', () => {
  it('opens the Archived section (remembered) when pressed', async () => {
    const r = renderRN(<ChatsScreen />);
    expect(getSectionOpen('archived', false)).toBe(false);
    const btn = findHost(r.root, byTestId('chats-archived-button'));
    expect(btn.props.accessibilityLabel).toBe('Archived chats');
    await actAsync(() => btn.props.onPress());
    expect(getSectionOpen('archived', false)).toBe(true);
  });

  it('is not drawn while searching', () => {
    const r = renderRN(<ChatsScreen />);
    actSync(() => findHost(r.root, byLabel('Search chats')).props.onPress());
    expect(findAllHost(r.root, byTestId('chats-archived-button'))).toHaveLength(0);
  });
});
