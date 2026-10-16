// Right-click menu on a sidebar chat row (spec/14 § Row context menu).
//
// User: "patch add a right click context menu on a sidebar chat, for things like
// archive". Archiving already worked from the hover tool — what was missing was
// the affordance, so these tests assert the menu reaches the SAME actions the
// row and the chat header already have, and that it opens, closes and is
// operable from the keyboard.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { ConfirmModal } from '../components/ConfirmModal.js';
import { SnoozeSheet } from '../components/SnoozeSheet.js';
import { PromptModal } from '../components/PromptModal.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { useSelectionStore } from '../stores/selectionStore.js';
import * as newWindow from '../lib/newWindow.js';
import { api } from '../api/rest.js';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import type { ChatRow } from '../stores/types.js';

function rowFixture(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId: 'c1',
    hostId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: 'a chat',
    folder: '~/proj',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: Date.now(),
    jobId: null,
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
    ...overrides,
  } as ChatRow;
}

function renderSidebar(): void {
  render(
    <MemoryRouter>
      <Sidebar />
      <ConfirmModal />
      <PromptModal />
      <SnoozeSheet />
    </MemoryRouter>,
  );
}

/** Right-click `el` and hand back whether the browser's own menu was refused. */
function rightClick(el: HTMLElement, at: { x: number; y: number } = { x: 120, y: 200 }): boolean {
  const ev = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: at.x,
    clientY: at.y,
  });
  fireEvent(el, ev);
  return ev.defaultPrevented;
}

const MENU = 'chat-context-menu-c1';

describe('sidebar row context menu', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useLayoutStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    useVoiceStore.setState({ activeDevices: {} });
    useUiStore.getState().setChannelsOpen(false);
    useUiStore.getState().setArchivedOpen(false);
    useUiStore.getState().setDeletedOpen(false);
    useUiStore.getState().setAttentionOnly(false);
    useUiStore.getState().setSearchQuery('');
    useUiStore.setState({ errors: [], forgottenFolders: [], toolsPanelChatId: null });
    useUiStore.getState().resolveConfirm(false);
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({ chats: [], nextOffset: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('opens at the pointer on right-click, refusing the browser’s own menu, with the row’s actions', () => {
    useChatStore.getState().hydrate([rowFixture()]);
    renderSidebar();

    expect(screen.queryByTestId(MENU)).toBeNull();
    const prevented = rightClick(screen.getByTestId('chat-row-c1'));
    // Replacing the native menu is the point of the handler, not a detail.
    expect(prevented).toBe(true);

    const menu = screen.getByTestId(MENU);
    expect(menu.getAttribute('role')).toBe('menu');
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent)).toEqual([
      'Open in new tab',
      'Open to the side',
      'Open in new window',
      'Rename',
      'Pin',
      'Snooze',
      'Hide',
      'Archive',
      'Delete',
    ]);
    // Anchored where the pointer was.
    expect(menu.style.left).toBe('120px');
    expect(menu.style.top).toBe('200px');
  });

  it('Rename prompts seeded with the stored name and renames optimistically', async () => {
    useChatStore.getState().hydrate([rowFixture({ name: 'old name' })]);
    const spy = vi.spyOn(api, 'renameChat').mockResolvedValue(undefined as never);
    renderSidebar();
    rightClick(screen.getByTestId('chat-row-c1'));
    fireEvent.click(screen.getByText('Rename'));
    const input = (await screen.findByTestId('prompt-input')) as HTMLInputElement;
    expect(input.value).toBe('old name');
    fireEvent.change(input, { target: { value: '  new name ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(spy).toHaveBeenCalledWith('c1', 'new name'));
    expect(useChatStore.getState().chats['c1']?.name ?? null).toBe('new name');
  });

  it('archives through the SAME path as the hover tool, and closes', async () => {
    useChatStore.getState().hydrate([rowFixture()]);
    const archive = vi.spyOn(api, 'archiveChat').mockResolvedValue(undefined as never);
    renderSidebar();

    rightClick(screen.getByTestId('chat-row-c1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`${MENU}-archive`));
    });

    expect(useChatStore.getState().chats['c1']?.status).toBe('archived');
    expect(archive).toHaveBeenCalledWith('c1', true);
    expect(screen.queryByTestId(MENU)).toBeNull();
  });

  it('Snooze opens the same Snooze sheet as the header, applying nothing until confirmed', async () => {
    useChatStore.getState().hydrate([rowFixture()]);
    const snooze = vi.spyOn(api, 'snoozeChat').mockResolvedValue(undefined as never);
    renderSidebar();

    rightClick(screen.getByTestId('chat-row-c1'));
    expect(screen.queryByTestId(`${MENU}-snooze-1-hour`)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId(`${MENU}-snooze`));
    });
    expect(screen.queryByTestId(MENU)).toBeNull();
    expect(useUiStore.getState().snoozeSheet).toEqual({ kind: 'chat', chatId: 'c1' });
    expect(screen.getByTestId('snooze-sheet')).toBeTruthy();
    expect(snooze).not.toHaveBeenCalled();

    const before = Date.now();
    fireEvent.click(screen.getByTestId('snooze-sheet-preset-1-hour'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('snooze-sheet-confirm'));
    });
    const until = useChatStore.getState().chats['c1']?.snoozedUntil as number;
    expect(until).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(snooze).toHaveBeenCalledWith('c1', until, expect.any(String));
  });

  it('pins through the row’s own pin action', async () => {
    useChatStore.getState().hydrate([rowFixture()]);
    const pin = vi.spyOn(api, 'pinChat').mockResolvedValue(undefined as never);
    renderSidebar();

    rightClick(screen.getByTestId('chat-row-c1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`${MENU}-pin`));
    });

    expect(useChatStore.getState().chats['c1']?.pinned).toBe(true);
    expect(pin).toHaveBeenCalledWith('c1', true);
  });

  it('Hide hides the chat through the row’s hide API, and reverts on failure', async () => {
    useChatStore.getState().hydrate([rowFixture()]);
    const hide = vi.spyOn(api, 'hideChat').mockResolvedValue(undefined as never);
    renderSidebar();

    rightClick(screen.getByTestId('chat-row-c1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`${MENU}-hide`));
    });
    expect(useChatStore.getState().chats['c1']?.hidden).toBe(true);
    expect(hide).toHaveBeenCalledWith('c1', true);
  });

  it('Hide reverts when the request fails', async () => {
    useChatStore.getState().hydrate([rowFixture()]);
    vi.spyOn(api, 'hideChat').mockRejectedValue(new Error('boom'));
    renderSidebar();

    rightClick(screen.getByTestId('chat-row-c1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`${MENU}-hide`));
    });
    await waitFor(() => expect(useChatStore.getState().chats['c1']?.hidden).toBe(false));
  });

  it('"Open in new tab" opens the chat as a new tab in the active pane (spec/14 § Panes and tabs)', async () => {
    useChatStore.getState().hydrate([rowFixture()]);
    renderSidebar();

    rightClick(screen.getByTestId('chat-row-c1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`${MENU}-open-new-tab`));
    });

    const root = useLayoutStore.getState().root;
    expect(root.type).toBe('leaf');
    expect(
      (root as { tabs: { descriptor: { chatId: string } }[] }).tabs.map((t) => t.descriptor.chatId),
    ).toEqual(['c1']);
  });

  it('"Open to the side" splits the pane with the chat in the new one', async () => {
    useChatStore.getState().hydrate([rowFixture()]);
    renderSidebar();

    rightClick(screen.getByTestId('chat-row-c1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`${MENU}-open-to-the-side`));
    });

    expect(useLayoutStore.getState().root.type).toBe('split');
  });

  it('"Open in new window" opens the chat in its own window', async () => {
    useChatStore.getState().hydrate([rowFixture()]);
    const spy = vi.spyOn(newWindow, 'openChatInNewWindow').mockImplementation(() => {});
    renderSidebar();

    rightClick(screen.getByTestId('chat-row-c1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`${MENU}-open-new-window`));
    });

    expect(spy).toHaveBeenCalledWith('c1');
  });

  it('middle-click opens the chat as a new tab instead of a browser tab', () => {
    useChatStore.getState().hydrate([rowFixture(), rowFixture({ chatId: 'c2' })]);
    renderSidebar();

    const ev = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    fireEvent(screen.getByTestId('chat-row-c2'), ev);

    expect(ev.defaultPrevented).toBe(true);
    const root = useLayoutStore.getState().root;
    expect(root.type).toBe('leaf');
    expect(
      (root as { tabs: { descriptor: { chatId: string } }[] }).tabs.map((t) => t.descriptor.chatId),
    ).toEqual(['c2']);
  });

  it('Delete asks for confirmation first, exactly as the header does', async () => {
    useChatStore.getState().hydrate([rowFixture()]);
    const del = vi.spyOn(api, 'deleteChat').mockResolvedValue(undefined as never);
    renderSidebar();

    rightClick(screen.getByTestId('chat-row-c1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`${MENU}-delete`));
    });
    // Nothing has happened yet — the confirm is up.
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByTestId('confirm-modal')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-ok'));
    });
    await waitFor(() => expect(del).toHaveBeenCalledWith('c1'));
  });

  it('a deleted row offers Restore alone; a snoozed row leads with Unsnooze', () => {
    useChatStore
      .getState()
      .hydrate([rowFixture({ chatId: 'c1', status: 'deleted' }), rowFixture({ chatId: 'c2' })]);
    useUiStore.getState().setDeletedOpen(true);
    renderSidebar();

    rightClick(screen.getByTestId('chat-row-c1'));
    expect(
      [...screen.getByTestId(MENU).querySelectorAll('[role="menuitem"]')].map((n) => n.textContent),
    ).toEqual(['Restore']);

    cleanup();
    useChatStore
      .getState()
      .hydrate([rowFixture({ chatId: 'c1', snoozedUntil: Date.now() + 60_000 })]);
    useUiStore.setState({ snoozedOpen: true });
    renderSidebar();
    rightClick(screen.getByTestId('chat-row-c1'));
    expect(
      [...screen.getByTestId(MENU).querySelectorAll('[role="menuitem"]')][0]?.textContent,
    ).toBe('Unsnooze');
    expect(screen.getByTestId(MENU).textContent).not.toMatch(/^Snooze|\bSnooze(?!d)/);
  });

  it('a special thread has no menu, so the browser keeps its own', () => {
    const managerId = SPECIAL_THREAD_IDS.manager;
    useChatStore.getState().hydrate([rowFixture({ chatId: managerId, name: 'Manager' })]);
    renderSidebar();

    const prevented = rightClick(screen.getByTestId(`chat-row-${managerId}`));
    expect(prevented).toBe(false);
    expect(screen.queryByTestId(`chat-context-menu-${managerId}`)).toBeNull();
  });

  it('is keyboard operable: focus lands on the first item, arrows walk it, Esc closes and hands focus back', () => {
    useChatStore.getState().hydrate([rowFixture()]);
    renderSidebar();

    const row = screen.getByTestId('chat-row-c1');
    row.focus();
    // The platform menu key fires `contextmenu` with no pointer behind it; the
    // menu anchors to the focused row rather than the window corner.
    rightClick(row, { x: 0, y: 0 });

    const items = [...screen.getByTestId(MENU).querySelectorAll('[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(window, { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[items.length - 1]);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId(MENU)).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('closes on a pointer-down outside it, and on a scroll underneath it', () => {
    useChatStore.getState().hydrate([rowFixture()]);
    renderSidebar();

    rightClick(screen.getByTestId('chat-row-c1'));
    expect(screen.getByTestId(MENU)).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId(MENU)).toBeNull();

    rightClick(screen.getByTestId('chat-row-c1'));
    expect(screen.getByTestId(MENU)).toBeInTheDocument();
    // Anchored to a point, so a list scrolling under it would leave it over a
    // different chat holding the first one's actions.
    fireEvent.scroll(screen.getByTestId('chat-row-c1'));
    expect(screen.queryByTestId(MENU)).toBeNull();
  });
});

describe('sidebar row context menu over a multi-selection', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useLayoutStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    useVoiceStore.setState({ activeDevices: {} });
    useUiStore.getState().setArchivedOpen(false);
    useUiStore.getState().setDeletedOpen(false);
    useUiStore.getState().setAttentionOnly(false);
    useUiStore.getState().setSearchQuery('');
    useUiStore.setState({ errors: [], forgottenFolders: [], toolsPanelChatId: null });
    useUiStore.getState().resolveConfirm(false);
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({ chats: [], nextOffset: null });
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'c1' }),
        rowFixture({ chatId: 'c2' }),
        rowFixture({ chatId: 'c3' }),
      ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useSelectionStore.getState().clear();
    cleanup();
  });

  function selectTwo(): void {
    renderSidebar();
    fireEvent.click(screen.getByTestId('chat-row-c1'));
    fireEvent.click(screen.getByTestId('chat-row-c2'), { shiftKey: true });
    expect(useSelectionStore.getState().selected.length).toBe(2);
  }

  it('offers only the bulk actions when the clicked row is selected, and pins every selected chat', async () => {
    selectTwo();
    const [a, b] = useSelectionStore.getState().selected as [string, string];
    const pin = vi.spyOn(api, 'pinChat').mockResolvedValue(undefined as never);
    rightClick(screen.getByTestId(`chat-row-${a}`));
    const menu = screen.getByTestId(`chat-context-menu-${a}`);
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent)).toEqual([
      'Pin',
      'Snooze',
      'Hide',
      'Archive',
      'Delete',
    ]);
    await act(async () => {
      fireEvent.click(screen.getByTestId(`chat-context-menu-${a}-pin`));
    });
    expect(pin).toHaveBeenCalledTimes(2);
    expect(pin).toHaveBeenCalledWith(a, true);
    expect(pin).toHaveBeenCalledWith(b, true);
    expect(useChatStore.getState().chats['c3']?.pinned).toBe(false);
  });

  it('Snooze over a selection opens the sheet for every selected chat, then clears the selection', async () => {
    selectTwo();
    const [a, b] = useSelectionStore.getState().selected as [string, string];
    const snooze = vi.spyOn(api, 'snoozeChat').mockResolvedValue(undefined as never);
    rightClick(screen.getByTestId(`chat-row-${a}`));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`chat-context-menu-${a}-snooze`));
    });
    expect(screen.getByTestId('snooze-sheet-subtitle').textContent).toBe('2 chats');
    expect(snooze).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('snooze-sheet-preset-1-hour'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('snooze-sheet-confirm'));
    });
    expect(snooze).toHaveBeenCalledTimes(2);
    expect(snooze.mock.calls.map((c) => c[0]).sort()).toEqual([a, b].sort());
    expect(useSelectionStore.getState().selected.length).toBe(0);
  });

  it('archives every selected chat after one confirm', async () => {
    selectTwo();
    const archive = vi.spyOn(api, 'archiveChat').mockResolvedValue(undefined as never);
    rightClick(screen.getByTestId('chat-row-c1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-context-menu-c1-archive'));
    });
    await waitFor(() => expect(useUiStore.getState().confirmDialog).not.toBeNull());
    await act(async () => {
      useUiStore.getState().resolveConfirm(true);
    });
    await waitFor(() => expect(archive).toHaveBeenCalledTimes(2));
    expect(useChatStore.getState().chats['c3']?.status).not.toBe('archived');
  });

  it('acts on just the clicked row when it is outside the selection', () => {
    selectTwo();
    rightClick(screen.getByTestId('chat-row-c3'));
    const menu = screen.getByTestId('chat-context-menu-c3');
    expect(menu.textContent).toContain('Rename');
    expect(useSelectionStore.getState().selected).toEqual([]);
  });
});
