// Archiving a conversation on the phone, end to end through the Chats tab
// (spec/04 § Lifecycle): the row's swipe tray archives it, it leaves the
// active list for the Archived section, the tray there unarchives it, a
// refused request puts it back with a toast, and another surface's
// `chat.state` moves it live. Unit coverage of the pieces lives in
// ChatRow / ChatLongPressSheet / chatStore tests; this file drives the screen
// the user sees, with the real store, rows and toggle — only the network is
// mocked.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderRN, findAllHost, byType, hasText, actSync, actAsync } from './testUtils/render';
import ChatsScreen from '../app/(tabs)/chats';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useUiStore } from '../src/stores/uiStore';
import { __resetRouterMock } from './stubs/expo-router';
import { __clearAllMmkv } from './stubs/mmkv';
import { setSectionOpen } from '../src/lib/sectionCollapse';

vi.mock('../src/lib/voiceNote', () => ({
  startVoiceNote: vi.fn(),
  releaseVoiceNoteIfHeld: vi.fn(),
}));
const { countsSpy, listArchivedSpy, listHiddenSpy, archiveChatSpy } = vi.hoisted(() => ({
  countsSpy: vi.fn(),
  listArchivedSpy: vi.fn(),
  listHiddenSpy: vi.fn(),
  archiveChatSpy: vi.fn(),
}));
vi.mock('../src/api/rest', () => ({
  api: {
    chatSectionCounts: countsSpy,
    listArchivedChats: listArchivedSpy,
    listHiddenChats: listHiddenSpy,
    archiveChat: archiveChatSpy,
  },
}));

type HydrateRow = Parameters<ReturnType<typeof useChatStore.getState>['hydrate']>[0][number];

function row(overrides: Partial<HydrateRow> & { chatId: string }): HydrateRow {
  return {
    name: null,
    folder: 'work',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 1,
    lastUserActivity: 1,
    ...overrides,
  };
}

function texts(r: ReturnType<typeof renderRN>): string[] {
  return findAllHost(r.root, byType('Text')).map((t) =>
    typeof t.children[0] === 'string' ? t.children[0] : '',
  );
}

/** The tray button for `label` on the row named `name` (both edges render one; take the first). */
function trayButton(r: ReturnType<typeof renderRN>, name: string, label: string) {
  const surface = findAllHost(r.root, (i) => i.props.testID === 'chat-row-surface').find((s) =>
    hasText(s, name),
  )!;
  const rowRoot = surface.parent!.parent!;
  return findAllHost(rowRoot, (i) => i.props.accessibilityLabel === label)[0]!;
}

beforeEach(() => {
  __clearAllMmkv();
  countsSpy
    .mockReset()
    .mockResolvedValue({ archived: 0, snoozed: 0, hidden: 0, deleted: 0, automations: 0 });
  listArchivedSpy.mockReset().mockResolvedValue({ chats: [], nextOffset: null });
  listHiddenSpy.mockReset().mockResolvedValue({ chats: [] });
  archiveChatSpy.mockReset().mockResolvedValue(undefined);
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  __resetRouterMock();
});

describe('archiving from the Chats tab', () => {
  it('the tray Archive moves the chat out of its folder into Archived and tells the server', async () => {
    setSectionOpen('archived', true);
    useChatStore.getState().hydrate([row({ chatId: 'c1', name: 'Plan the trip' })]);
    const r = renderRN(<ChatsScreen />);
    await actAsync(async () => {});
    expect(hasText(r.root, 'Archived ▾')).toBe(true);
    expect(texts(r).filter((t) => t === 'Plan the trip')).toHaveLength(1);

    actSync(() => trayButton(r, 'Plan the trip', 'Archive chat').props.onPress());
    await actAsync(async () => {});

    expect(archiveChatSpy).toHaveBeenCalledWith('c1', true);
    expect(useChatStore.getState().chats['c1']!.status).toBe('archived');
    // Still drawn exactly once — now below the Archived header, offering Unarchive.
    const t = texts(r);
    expect(t.filter((x) => x === 'Plan the trip')).toHaveLength(1);
    expect(t.indexOf('Plan the trip')).toBeGreaterThan(t.indexOf('Archived ▾'));
    expect(trayButton(r, 'Plan the trip', 'Unarchive chat')).toBeTruthy();
  });

  it('archiving one chat leaves its neighbours in the active list', async () => {
    setSectionOpen('archived', true);
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'c1', name: 'Keep me', lastUpdated: 2 }),
        row({ chatId: 'c2', name: 'Put me away', lastUpdated: 1 }),
      ]);
    const r = renderRN(<ChatsScreen />);
    await actAsync(async () => {});
    actSync(() => trayButton(r, 'Put me away', 'Archive chat').props.onPress());
    await actAsync(async () => {});
    const t = texts(r);
    expect(t.indexOf('Keep me')).toBeLessThan(t.indexOf('Archived ▾'));
    expect(t.indexOf('Put me away')).toBeGreaterThan(t.indexOf('Archived ▾'));
    expect(useChatStore.getState().chats['c1']!.status).toBe('active');
  });

  it('a refused archive puts the chat back in the active list and raises an error', async () => {
    setSectionOpen('archived', true);
    archiveChatSpy.mockRejectedValue(new Error('host offline'));
    useChatStore.getState().hydrate([row({ chatId: 'c1', name: 'Plan the trip' })]);
    const r = renderRN(<ChatsScreen />);
    await actAsync(async () => {});
    actSync(() => trayButton(r, 'Plan the trip', 'Archive chat').props.onPress());
    await actAsync(async () => {});

    expect(useChatStore.getState().chats['c1']!.status).toBe('active');
    const t = texts(r);
    expect(t.indexOf('Plan the trip')).toBeLessThan(t.indexOf('Archived ▾'));
    expect(useUiStore.getState().errors.map((e) => e.message)).toContain(
      'archive failed: host offline',
    );
  });
});

describe('unarchiving from the Archived section', () => {
  it("opening Archived lists the server's chats; their tray Unarchive returns them to the active list", async () => {
    countsSpy.mockResolvedValue({ archived: 1, snoozed: 0, hidden: 0, deleted: 0, automations: 0 });
    listArchivedSpy.mockResolvedValue({
      chats: [
        {
          chatId: 'a1',
          name: 'Old project',
          hostId: 'd1',
          folder: 'work',
          activity: 'idle',
          permissionMode: 'default',
          status: 'archived',
          pinned: false,
          pinnedAt: null,
          lastUpdated: 5,
          pendingWake: null,
          snoozedUntil: null,
        },
      ],
      nextOffset: null,
    });
    const r = renderRN(<ChatsScreen />);
    await actAsync(async () => {});
    expect(hasText(r.root, 'Old project')).toBe(false);
    const header = findAllHost(r.root, byType('Pressable')).find((p) => hasText(p, 'Archived ▸'))!;
    actSync(() => header.props.onPress());
    await actAsync(async () => {});
    expect(hasText(r.root, 'Old project')).toBe(true);

    actSync(() => trayButton(r, 'Old project', 'Unarchive chat').props.onPress());
    await actAsync(async () => {});

    expect(archiveChatSpy).toHaveBeenCalledWith('a1', false);
    expect(useChatStore.getState().chats['a1']!.status).toBe('active');
    const t = texts(r);
    expect(t.indexOf('Old project')).toBeLessThan(t.indexOf('Archived ▾'));
  });
});

describe('archiving on another surface', () => {
  it('a chat.state flip to archived moves the row into Archived, and back on unarchive', async () => {
    setSectionOpen('archived', true);
    useChatStore.getState().hydrate([row({ chatId: 'c1', name: 'Shared chat' })]);
    const r = renderRN(<ChatsScreen />);
    await actAsync(async () => {});
    const flip = (status: 'archived' | 'active', lastUpdated: number) =>
      actSync(() =>
        useChatStore.getState().applyEvent({
          type: 'chat.state',
          chatId: 'c1',
          activity: 'idle',
          permissionMode: 'default',
          status,
          lastUpdated,
        }),
      );

    flip('archived', 10);
    let t = texts(r);
    expect(t.indexOf('Shared chat')).toBeGreaterThan(t.indexOf('Archived ▾'));
    expect(archiveChatSpy).not.toHaveBeenCalled();

    flip('active', 20);
    t = texts(r);
    expect(t.indexOf('Shared chat')).toBeLessThan(t.indexOf('Archived ▾'));
  });
});
