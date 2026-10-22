// Notifications drawer (spec/09 § bell, spec/15 § Notifications drawer): the
// Chats header bell, the history list, read state and opening the source chat.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  byLabel,
  hasText,
  actAsync,
} from './testUtils/render';
import ChatsScreen from '../app/(tabs)/chats';
import { NotificationsDrawer } from '../src/components/NotificationsDrawer';
import { useNotificationsStore } from '../src/stores/notificationsStore';
import { useChatStore } from '../src/stores/chatStore';
import { __resetRouterMock, routerMock } from './stubs/expo-router';
import { __clearAllMmkv } from './stubs/mmkv';

vi.mock('../src/lib/voiceNote', () => ({
  startVoiceNote: vi.fn(),
  releaseVoiceNoteIfHeld: vi.fn(),
}));

const { getNotifications, markNotificationsRead } = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  markNotificationsRead: vi.fn(),
}));
vi.mock('../src/api/rest', () => ({
  api: {
    getNotifications,
    markNotificationsRead,
    chatSectionCounts: vi
      .fn()
      .mockResolvedValue({ archived: 0, snoozed: 0, hidden: 0, deleted: 0, automations: 0 }),
    listArchivedChats: vi.fn().mockResolvedValue({ chats: [], nextOffset: null }),
    listHiddenChats: vi.fn().mockResolvedValue({ chats: [] }),
  },
}));

const entries = [
  {
    id: 'n2',
    chatId: 'c1',
    message: 'Build is green',
    importance: 'normal',
    sentAt: Date.now() - 5 * 60_000,
    readAt: null,
  },
  {
    id: 'n1',
    chatId: 'c1',
    message: 'Old news',
    importance: 'silent',
    sentAt: Date.now() - 3 * 3600_000,
    readAt: 1,
  },
];

beforeEach(() => {
  __clearAllMmkv();
  __resetRouterMock();
  useChatStore.getState()._reset();
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'Deploy chat',
      folder: '',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 0,
      snoozedUntil: null,
    },
  ]);
  useNotificationsStore.getState()._reset();
  getNotifications.mockReset().mockResolvedValue({ items: entries, unread: 1 });
  markNotificationsRead.mockReset().mockResolvedValue({
    items: [entries[0], entries[1]].map((e) => ({ ...e, readAt: 9 })),
    unread: 0,
  });
});

function App(): React.ReactElement {
  return (
    <>
      <ChatsScreen />
      <NotificationsDrawer />
    </>
  );
}

describe('notifications drawer', () => {
  it('bell opens a newest-first history with the unread one marked', async () => {
    await useNotificationsStore.getState().load();
    const r = renderRN(<App />);
    expect(queryHost(r.root, byTestId('notifications-drawer'))).toBeNull();
    const bell = findHost(r.root, byLabel('Notifications, 1 unread'));
    await actAsync(() => bell.props.onPress());
    const drawer = findHost(r.root, byTestId('notifications-drawer'));
    expect(hasText(drawer, 'Build is green')).toBe(true);
    expect(hasText(drawer, 'Old news')).toBe(true);
    expect(hasText(drawer, 'Deploy chat')).toBe(true);
    expect(
      findHost(r.root, byTestId('notification-item-n2')).props.accessibilityState.selected,
    ).toBe(true);
    expect(
      findHost(r.root, byTestId('notification-item-n1')).props.accessibilityState.selected,
    ).toBe(false);
  });

  it('tapping an entry marks it read and opens its source chat', async () => {
    await useNotificationsStore.getState().load();
    const r = renderRN(<App />);
    await actAsync(() => findHost(r.root, byLabel('Notifications, 1 unread')).props.onPress());
    await actAsync(() => findHost(r.root, byTestId('notification-item-n2')).props.onPress());
    expect(markNotificationsRead).toHaveBeenCalledWith({ ids: ['n2'] });
    expect(routerMock.push).toHaveBeenCalledWith('/chats/c1');
    expect(queryHost(r.root, byTestId('notifications-drawer'))).toBeNull();
  });

  it('Mark all read sends all:true', async () => {
    await useNotificationsStore.getState().load();
    const r = renderRN(<App />);
    await actAsync(() => findHost(r.root, byLabel('Notifications, 1 unread')).props.onPress());
    await actAsync(() => findHost(r.root, byTestId('notifications-mark-all')).props.onPress());
    expect(markNotificationsRead).toHaveBeenCalledWith({ all: true });
  });

  it('shows the error rather than an empty list when the load fails', async () => {
    getNotifications.mockRejectedValue(new Error('boom'));
    const r = renderRN(<App />);
    await actAsync(() => findHost(r.root, byLabel('Notifications')).props.onPress());
    expect(hasText(findHost(r.root, byTestId('notifications-error')), 'boom')).toBe(true);
  });
});
