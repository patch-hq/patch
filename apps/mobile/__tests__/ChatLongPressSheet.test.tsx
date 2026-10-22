// ChatLongPressSheet — the row-actions bottom sheet (spec/15 § Row tools):
// Pin/Unpin, Snooze/Unsnooze, Archive/Unarchive, Send voice note, Delete. Opened imperatively
// via showChatLongPressSheet(row) (an internal zustand store, not a prop),
// so these tests drive it the same way a real call site (the row's kebab /
// long-press) would.
//
// api.archiveChat/pinChat/deleteChat are mocked (network); startVoiceNote is
// mocked too so this file only asserts THIS component wires the gesture to
// the right chatId — the recording lifecycle itself is voiceNote.test.ts's job.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';
import {
  findHost,
  findAllHost,
  byType,
  byTestId,
  hasText,
  renderRN,
  update,
  actSync,
} from './testUtils/render';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { lightColors as colors, darkColors } from '../src/lib/theme';
import { __setColorScheme } from './stubs/react-native';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import type { ChatRow } from '../src/stores/types';
import { useSnoozeSheetStore } from '../src/components/SnoozeSheet';

const { renameChatSpy, archiveChatSpy, pinChatSpy, deleteChatSpy, snoozeChatSpy, hideChatSpy } =
  vi.hoisted(() => ({
    renameChatSpy: vi.fn().mockResolvedValue(undefined),
    hideChatSpy: vi.fn().mockResolvedValue(undefined),
    archiveChatSpy: vi.fn().mockResolvedValue(undefined),
    pinChatSpy: vi.fn().mockResolvedValue(undefined),
    deleteChatSpy: vi.fn().mockResolvedValue(undefined),
    snoozeChatSpy: vi.fn().mockResolvedValue(undefined),
  }));
vi.mock('../src/api/rest', () => ({
  api: {
    archiveChat: archiveChatSpy,
    pinChat: pinChatSpy,
    deleteChat: deleteChatSpy,
    snoozeChat: snoozeChatSpy,
    hideChat: hideChatSpy,
    renameChat: renameChatSpy,
  },
}));

const { startVoiceNoteSpy } = vi.hoisted(() => ({ startVoiceNoteSpy: vi.fn() }));
vi.mock('../src/lib/voiceNote', () => ({ startVoiceNote: startVoiceNoteSpy }));

import {
  ChatLongPressSheet,
  deleteChatRow,
  showChatLongPressSheet,
  showChatSnoozeSheet,
  toggleArchive,
  togglePin,
} from '../src/components/ChatLongPressSheet';

function row(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    chatId: 'c1',
    name: null,
    folder: 'work',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 0,
    awaitingPermission: false,
    lastReadSeq: 0,
    preview: null,
    pendingPermissions: [],
    lastSeq: 0,
    snoozedUntil: null,
    ...overrides,
  };
}

// The sheet container + backdrop are both bare Pressables with no
// accessibilityLabel; distinguish them by their own (plain-object, not
// function-style) `style`, the only thing that differs between them.
function byBackgroundColor(bg: string) {
  return (i: ReactTestInstance): boolean =>
    i.type === 'Pressable' &&
    (i.props['style'] as { backgroundColor?: string } | undefined)?.backgroundColor === bg;
}
const isBackdrop = byBackgroundColor(colors.shade);
const isSheetContainer = byBackgroundColor(colors.paperRaised);

/**
 * One of the 4 menu rows (Item component), found by its own label text.
 * Every ancestor Pressable (backdrop, sheet container) also "contains" every
 * row's text as a descendant, so a naive `hasText` search over ALL Pressables
 * would match the outermost one first. Filtering to LEAF Pressables (no
 * nested Pressable of their own) picks the actual row exactly once.
 */
function menuItem(root: ReactTestInstance, label: string): ReactTestInstance {
  const leaves = findAllHost(root, byType('Pressable')).filter(
    (p) => findAllHost(p, byType('Pressable')).length === 1 && hasText(p, label),
  );
  if (leaves.length !== 1) {
    throw new Error(`menuItem("${label}"): expected 1 match, found ${leaves.length}`);
  }
  return leaves[0]!;
}

beforeEach(() => {
  archiveChatSpy.mockClear();
  pinChatSpy.mockClear();
  deleteChatSpy.mockClear();
  snoozeChatSpy.mockClear();
  startVoiceNoteSpy.mockClear();
  useChatStore.getState()._reset();
  useChatStore.getState().hydrate([row(), row({ chatId: 'c2', pinned: true, status: 'archived' })]);
});

// The sheet's open row lives in a module-level store, so a test that opens it
// closes it again (via its own backdrop) rather than leak an open sheet into
// the next test.
function closeSheet(r: ReturnType<typeof renderRN>, shade: string): void {
  findHost(r.root, byBackgroundColor(shade)).props['onPress']();
}

afterEach(() => {
  __setColorScheme('light');
});

describe('ChatLongPressSheet — item order', () => {
  // Pin/Snooze/Archive in the swipe tray's order, then the voice note, with
  // Delete last — furthest from a thumb landing on the top of the sheet.
  // Batch membership is automatic (spec/15 § Batch view) — no row toggle.
  const LABELS = [
    'Pin chat',
    'Unpin chat',
    'Snooze chat',
    'Unsnooze chat',
    'Archive chat',
    'Unarchive chat',
    'Send voice note',
    'Delete chat',
  ];
  function itemOrder(root: ReactTestInstance): string[] {
    return findAllHost(root, byType('Text'))
      .map((t) => (typeof t.children[0] === 'string' ? t.children[0] : ''))
      .filter((t) => LABELS.includes(t));
  }

  it('reads Pin, Snooze, Archive, Send voice note, Delete', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    expect(itemOrder(r.root)).toEqual([
      'Pin chat',
      'Snooze chat',
      'Archive chat',
      'Send voice note',
      'Delete chat',
    ]);
    closeSheet(r, colors.shade);
  });

  it('keeps the order when every toggle reads its undo', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(
      row({ chatId: 'c1', pinned: true, status: 'archived', snoozedUntil: Date.now() + 60_000 }),
    );
    update(r, <ChatLongPressSheet />);
    expect(itemOrder(r.root)).toEqual([
      'Unpin chat',
      'Unsnooze chat',
      'Unarchive chat',
      'Send voice note',
      'Delete chat',
    ]);
    closeSheet(r, colors.shade);
  });
});

describe('ChatLongPressSheet — dark mode', () => {
  it('draws the sheet and its items from the dark palette', () => {
    __setColorScheme('dark');
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1', name: 'Night chat' }));
    update(r, <ChatLongPressSheet />);
    expect(() => findHost(r.root, byBackgroundColor(darkColors.paperRaised))).not.toThrow();
    expect(() => findHost(r.root, byBackgroundColor(darkColors.shade))).not.toThrow();
    const title = findHost(r.root, (i) => i.type === 'Text' && i.children[0] === 'Night chat');
    expect((title.props['style'] as { color: string }).color).toBe(darkColors.ink);
    closeSheet(r, darkColors.shade);
  });
});

describe('ChatLongPressSheet — closed state', () => {
  it('renders an invisible Modal (no content) until a row is shown', () => {
    const r = renderRN(<ChatLongPressSheet />);
    // Modal stub renders nothing while `visible` is false.
    expect(r.toJSON()).toBeNull();
  });
});

describe('ChatLongPressSheet — opened via showChatLongPressSheet(row)', () => {
  it('shows the chat name when set, else falls back to the chatId', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ name: 'Kitchen remodel' }));
    update(r, <ChatLongPressSheet />);
    expect(hasText(r.root, 'Kitchen remodel')).toBe(true);

    showChatLongPressSheet(row({ chatId: 'no-name-chat', name: null }));
    update(r, <ChatLongPressSheet />);
    expect(hasText(r.root, 'no-name-chat')).toBe(true);
  });

  it('an active chat offers "Archive chat"; pressing closes the sheet and archives', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1', status: 'active' }));
    update(r, <ChatLongPressSheet />);
    expect(hasText(r.root, 'Archive chat')).toBe(true);

    menuItem(r.root, 'Archive chat').props['onPress']();

    expect(useChatStore.getState().chats['c1']?.status).toBe('archived');
    expect(archiveChatSpy).toHaveBeenCalledWith('c1', true);
    // Pressing an item closes the sheet (row goes back to null).
    update(r, <ChatLongPressSheet />);
    expect(r.toJSON()).toBeNull();
  });

  it('an archived chat offers "Unarchive chat"; pressing unarchives', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c2', status: 'archived' }));
    update(r, <ChatLongPressSheet />);
    expect(hasText(r.root, 'Unarchive chat')).toBe(true);
    // The icon flips too — an open box for the way back, not the closed
    // Archive glyph used to put a chat away.
    expect(() =>
      findHost(menuItem(r.root, 'Unarchive chat'), (i) => i.props.name === 'PackageOpen'),
    ).not.toThrow();

    menuItem(r.root, 'Unarchive chat').props['onPress']();
    expect(useChatStore.getState().chats['c2']?.status).toBe('active');
    expect(archiveChatSpy).toHaveBeenCalledWith('c2', false);
  });

  it('"Send voice note" closes the sheet and starts a note for this chat', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    menuItem(r.root, 'Send voice note').props['onPress']();
    expect(startVoiceNoteSpy).toHaveBeenCalledWith('c1');
    update(r, <ChatLongPressSheet />);
    expect(r.toJSON()).toBeNull();
  });

  it('an unpinned chat offers "Pin chat"; pressing pins', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1', pinned: false }));
    update(r, <ChatLongPressSheet />);
    menuItem(r.root, 'Pin chat').props['onPress']();
    expect(useChatStore.getState().chats['c1']?.pinned).toBe(true);
    expect(pinChatSpy).toHaveBeenCalledWith('c1', true);
  });

  it('a pinned chat offers "Unpin chat"; pressing unpins', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c2', pinned: true }));
    update(r, <ChatLongPressSheet />);
    menuItem(r.root, 'Unpin chat').props['onPress']();
    expect(useChatStore.getState().chats['c2']?.pinned).toBe(false);
    expect(pinChatSpy).toHaveBeenCalledWith('c2', false);
  });

  it('"Delete chat" (destructive) closes the sheet, deletes remotely and removes the row', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    menuItem(r.root, 'Delete chat').props['onPress']();
    expect(deleteChatSpy).toHaveBeenCalledWith('c1');
    expect(useChatStore.getState().chats['c1']).toBeUndefined();
  });

  it('pressing the backdrop closes the sheet without side effects', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    const backdrop = findHost(r.root, isBackdrop);
    backdrop.props['onPress']();
    update(r, <ChatLongPressSheet />);
    expect(r.toJSON()).toBeNull();
    expect(archiveChatSpy).not.toHaveBeenCalled();
  });

  it('pressing the sheet container itself is a no-op (does not bubble to the backdrop close)', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    const container = findHost(r.root, isSheetContainer);
    // Exercises the `onPress={() => {}}` no-op directly (function coverage);
    // the stub does not simulate real bubbling, so this proves the handler
    // itself does nothing rather than proving bubbling is blocked.
    expect(() => container.props['onPress']()).not.toThrow();
    update(r, <ChatLongPressSheet />);
    // Still open — no close() was triggered by this no-op handler.
    expect(r.toJSON()).not.toBeNull();
  });

  it('an active chat offers "Hide chat"; pressing hides it and closes the sheet (spec/04 § Hidden)', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1', status: 'active' }));
    update(r, <ChatLongPressSheet />);

    menuItem(r.root, 'Hide chat').props['onPress']();

    expect(useChatStore.getState().chats['c1']?.hidden).toBe(true);
    expect(hideChatSpy).toHaveBeenCalledWith('c1', true);
    update(r, <ChatLongPressSheet />);
    expect(r.toJSON()).toBeNull();
  });

  it('"Hide chat" is not offered for a hidden chat, an archived chat or a special thread', () => {
    const r = renderRN(<ChatLongPressSheet />);
    for (const overrides of [
      { chatId: 'c1', hidden: true },
      { chatId: 'c1', status: 'archived' as const },
      { chatId: SPECIAL_THREAD_IDS.manager },
    ]) {
      showChatLongPressSheet(row(overrides));
      update(r, <ChatLongPressSheet />);
      expect(hasText(r.root, 'Hide chat')).toBe(false);
    }
  });

  it('a failed hide REVERTS the optimistic flip and surfaces the error', async () => {
    hideChatSpy.mockRejectedValueOnce(new Error('nope'));
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    menuItem(r.root, 'Hide chat').props['onPress']();
    await vi.waitFor(() => expect(useChatStore.getState().chats['c1']?.hidden).toBeFalsy());
    expect(useUiStore.getState().errors.some((e) => /hide failed: nope/.test(e.message))).toBe(
      true,
    );
  });

  it('a snoozable chat offers "Snooze chat"; a special thread does not (spec/04 § Snooze)', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    expect(hasText(r.root, 'Snooze chat')).toBe(true);

    showChatLongPressSheet(row({ chatId: SPECIAL_THREAD_IDS.manager }));
    update(r, <ChatLongPressSheet />);
    expect(hasText(r.root, 'Snooze chat')).toBe(false);
    // The rest of the sheet is unaffected.
    expect(hasText(r.root, 'Delete chat')).toBe(true);
  });

  it('an Item row exercises both pressed-style branches via onPressIn/onPressOut', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    const item = menuItem(r.root, 'Pin chat');
    expect((item.props['style'] as { backgroundColor: string }).backgroundColor).toBe(
      'transparent',
    );
    item.props['onPressIn']();
    // Re-read: Pressable resolves style fresh against ITS OWN pressed state.
    const pressedItem = menuItem(r.root, 'Pin chat');
    expect((pressedItem.props['style'] as { backgroundColor: string }).backgroundColor).toBe(
      colors.divider,
    );
    pressedItem.props['onPressOut']();
  });
});

describe('ChatLongPressSheet — snooze (spec/04 § Snooze)', () => {
  const NOW = new Date('2026-08-25T10:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('"Snooze chat" hands off to the Snooze sheet without snoozing anything yet', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1' }));
    update(r, <ChatLongPressSheet />);
    menuItem(r.root, 'Snooze chat').props['onPress']();
    update(r, <ChatLongPressSheet />);

    expect(useSnoozeSheetStore.getState().target).toEqual({ kind: 'chat', chatId: 'c1' });
    // The actions sheet is gone; the presets live in the Snooze sheet.
    expect(r.toJSON()).toBeNull();
    expect(snoozeChatSpy).not.toHaveBeenCalled();
    useSnoozeSheetStore.getState().close();
  });

  it('an already-snoozed chat offers "Unsnooze chat", clearing it in one tap (no preset list)', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1', snoozedUntil: NOW + 60_000 }));
    update(r, <ChatLongPressSheet />);
    expect(hasText(r.root, 'Snooze chat')).toBe(false);

    menuItem(r.root, 'Unsnooze chat').props['onPress']();
    expect(snoozeChatSpy).toHaveBeenCalledWith('c1', null);
    expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBeNull();
  });

  it('a chat whose snooze has LAPSED offers Snooze again (derived from the clock)', () => {
    const r = renderRN(<ChatLongPressSheet />);
    showChatLongPressSheet(row({ chatId: 'c1', snoozedUntil: NOW - 1 }));
    update(r, <ChatLongPressSheet />);
    expect(hasText(r.root, 'Snooze chat')).toBe(true);
    expect(hasText(r.root, 'Unsnooze chat')).toBe(false);
  });

  it('showChatSnoozeSheet opens the Snooze sheet for the chat (the chat-detail kebab route)', () => {
    showChatSnoozeSheet(row({ chatId: 'c1' }));
    expect(useSnoozeSheetStore.getState().target).toEqual({ kind: 'chat', chatId: 'c1' });
    useSnoozeSheetStore.getState().close();
  });
});

describe('pin / archive / delete — refused by the server', () => {
  const failures = (): string[] => useUiStore.getState().errors.map((e) => e.message);
  beforeEach(() => {
    useUiStore.setState({ errors: [] });
  });

  it('a refused pin puts the chat back to unpinned and says so', async () => {
    pinChatSpy.mockRejectedValueOnce(new Error('nope'));
    const before = useChatStore.getState().chats['c1']!;
    togglePin(before);
    expect(useChatStore.getState().chats['c1']?.pinned).toBe(true);
    await vi.waitFor(() => expect(useChatStore.getState().chats['c1']?.pinned).toBe(false));
    expect(failures().some((m) => /pin failed: nope/.test(m))).toBe(true);
  });

  it('a refused archive brings the chat back to active and says so', async () => {
    archiveChatSpy.mockRejectedValueOnce(new Error('nope'));
    toggleArchive(useChatStore.getState().chats['c1']!);
    expect(useChatStore.getState().chats['c1']?.status).toBe('archived');
    await vi.waitFor(() => expect(useChatStore.getState().chats['c1']?.status).toBe('active'));
    expect(failures().some((m) => /archive failed: nope/.test(m))).toBe(true);
  });

  it('a refused unpin puts the pin back at its ORIGINAL time, not a fresh one', async () => {
    pinChatSpy.mockRejectedValueOnce(new Error('nope'));
    useChatStore.getState().setPinned('c1', true, 100);
    const pinned = useChatStore.getState().chats['c1']!;
    togglePin(pinned);
    expect(useChatStore.getState().chats['c1']?.pinned).toBe(false);
    await vi.waitFor(() => expect(useChatStore.getState().chats['c1']?.pinned).toBe(true));
    expect(useChatStore.getState().chats['c1']?.pinnedAt).toBe(100);
  });

  it('a refused delete restores the chat with its transcript, branches and read mark, and says so', async () => {
    deleteChatSpy.mockRejectedValueOnce(new Error('nope'));
    const s = useChatStore.getState();
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'assistant',
      content: 'hello',
    });
    s.applyEvent({
      type: 'chat.branches',
      chatId: 'c1',
      activeBranchId: 'b0',
      branches: [
        { branchId: 'b0', parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 1 },
      ],
    });
    s.setActiveChat('c1');
    const visitedAt = useChatStore.getState().chats['c1']!.lastReadSeq;
    expect(visitedAt).toBeGreaterThan(0);

    deleteChatRow(useChatStore.getState().chats['c1']!);
    expect(useChatStore.getState().chats['c1']).toBeUndefined();
    expect(useChatStore.getState().branchGraphs['c1']).toBeUndefined();

    await vi.waitFor(() => expect(useChatStore.getState().chats['c1']).toBeDefined());
    const after = useChatStore.getState();
    expect(after.timelines['c1']?.map((e) => e.content)).toEqual(['hello']);
    expect(after.branchGraphs['c1']?.activeBranchId).toBe('b0');
    expect(after.chats['c1']?.lastReadSeq).toBe(visitedAt);
    expect(failures().some((m) => /delete failed: nope/.test(m))).toBe(true);
  });

  it('an accepted delete leaves the chat gone', async () => {
    deleteChatRow(useChatStore.getState().chats['c1']!);
    await Promise.resolve();
    expect(deleteChatSpy).toHaveBeenCalledWith('c1');
    expect(useChatStore.getState().chats['c1']).toBeUndefined();
    expect(failures()).toEqual([]);
  });
});

describe('ChatLongPressSheet — rename', () => {
  it('Rename chat opens a field seeded with the stored name; Save renames optimistically', () => {
    useChatStore.getState().setName('c1', 'old');
    const r = renderRN(<ChatLongPressSheet />);
    actSync(() => showChatLongPressSheet(useChatStore.getState().chats['c1']!));
    findHost(
      r.root,
      (i) =>
        i.type === 'Pressable' &&
        hasText(i, 'Rename chat') &&
        findAllHost(i, byType('Pressable')).length === 1,
    ).props['onPress']();
    const input = findHost(r.root, byTestId('rename-input'));
    expect(input.props['value']).toBe('old');
    actSync(() => input.props['onChangeText'](' new '));
    actSync(() => findHost(r.root, byTestId('rename-input')).props['onSubmitEditing']());
    expect(renameChatSpy).toHaveBeenCalledWith('c1', 'new');
    expect(useChatStore.getState().chats['c1']!.name).toBe('new');
  });
});
