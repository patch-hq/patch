// PaneArea / TabBar — the pieces of the pane/tab layout that don't need a
// real browser to drive (click-to-activate, close, middle-click-close,
// click-to-focus-a-pane, and the hide-when-trivial rule). Drag-and-drop
// (reorder, move between panes, split by dragging to an edge) and divider
// resizing need real pointer/DataTransfer behaviour jsdom can't give them —
// those are e2e/panes-and-tabs.spec.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, createEvent, act } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import type { JSX } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PaneArea } from '../components/PaneArea.js';
import { useChatStore } from '../stores/chatStore.js';
import { useLayoutStore, type LeafPane, type SplitPane } from '../stores/layoutStore.js';

/** Every descriptor in this file is a chat tab — narrow past the union. */
function cid(d: { kind: string; chatId?: string }): string {
  if (d.kind !== 'chat' || typeof d.chatId !== 'string') throw new Error('not a chat descriptor');
  return d.chatId;
}

vi.mock('../api/rest.js', () => ({
  api: {
    getFileContent: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    getFileContentAtHead: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
  },
}));

function seedChats(ids: string[]): void {
  useChatStore.getState().hydrate(
    ids.map((chatId) => ({
      chatId,
      hostId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: chatId,
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    })),
  );
}

function renderPanes({ strict = false }: { strict?: boolean } = {}): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PaneArea ws={null} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

beforeEach(() => {
  useLayoutStore.getState()._reset();
  useChatStore.getState()._reset();
});

const settingsMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('../routes/SettingsRoute.js', async () => {
  const React = await import('react');
  return {
    SettingsRoute: () => {
      React.useEffect(() => {
        settingsMounts.count += 1;
      }, []);
      return <div data-testid="settings-stub" />;
    },
  };
});

const openTabInNewWindow = vi.hoisted(() => vi.fn());
vi.mock('../lib/newWindow.js', async (orig) => ({
  ...(await orig<typeof import('../lib/newWindow.js')>()),
  openTabInNewWindow,
}));

describe('PaneArea — close pane', () => {
  it('a pane in a split has a close-pane control that removes the whole pane; a lone pane has none', () => {
    seedChats(['c1', 'c2']);
    useLayoutStore.getState().openTab({ kind: 'chat', chatId: 'c1' });
    useLayoutStore
      .getState()
      .openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'split', edge: 'right' });
    const split = useLayoutStore.getState().root as SplitPane;
    const rightId = split.children[1]!.pane.id;
    renderPanes();
    fireEvent.click(screen.getByTestId(`pane-close-${rightId}`));
    const root = useLayoutStore.getState().root as LeafPane;
    expect(root.type).toBe('leaf');
    expect(root.tabs.map((t) => cid(t.descriptor))).toEqual(['c1']);
    expect(screen.queryByLabelText('Close pane')).toBeNull();
  });
});

describe('PaneArea — single pane, single tab', () => {
  it('always draws the tab row, so a lone chat tab can still be dragged', () => {
    seedChats(['c1']);
    useLayoutStore.getState().openTab({ kind: 'chat', chatId: 'c1' });
    renderPanes();
    const bar = screen.getByRole('tablist', { name: 'Tabs' });
    expect(bar.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(bar.querySelector('[role="tab"]')).toHaveAttribute('draggable', 'true');
    expect(screen.getByTestId('chat-main')).toBeInTheDocument();
  });
});

describe('PaneArea — one pane, several tabs', () => {
  function seedTwoTabs(): LeafPane {
    seedChats(['c1', 'c2']);
    useLayoutStore.getState().openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    useLayoutStore.getState().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    return useLayoutStore.getState().root as LeafPane;
  }

  it('shows a tab bar once there is a second tab', () => {
    seedTwoTabs();
    renderPanes();
    expect(screen.getByRole('tablist', { name: 'Tabs' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('clicking an inactive tab activates it', () => {
    const pane = seedTwoTabs();
    renderPanes();
    const firstTabId = pane.tabs[0]!.id;
    fireEvent.click(screen.getByTestId(`tab-${firstTabId}`));
    expect(useLayoutStore.getState().root).toMatchObject({ activeTabId: firstTabId });
  });

  it('clicking the close control removes that tab', () => {
    const pane = seedTwoTabs();
    renderPanes();
    const firstTabId = pane.tabs[0]!.id;
    fireEvent.click(screen.getByTestId(`tab-close-${firstTabId}`));
    const root = useLayoutStore.getState().root as LeafPane;
    expect(root.tabs.map((t) => cid(t.descriptor))).toEqual(['c2']);
  });

  it('middle-click (auxclick) on a tab closes it, same as the close control', () => {
    const pane = seedTwoTabs();
    renderPanes();
    const secondTabId = pane.tabs[1]!.id;
    fireEvent(
      screen.getByTestId(`tab-${secondTabId}`),
      new MouseEvent('auxclick', { bubbles: true, button: 1 }),
    );
    const root = useLayoutStore.getState().root as LeafPane;
    expect(root.tabs.map((t) => cid(t.descriptor))).toEqual(['c1']);
  });

  it('right-click opens a menu offering to split, open in a new window, or close', () => {
    const pane = seedTwoTabs();
    renderPanes();
    const firstTabId = pane.tabs[0]!.id;
    fireEvent.contextMenu(screen.getByTestId(`tab-${firstTabId}`));
    expect(screen.getByText('Open to the side')).toBeInTheDocument();
    expect(screen.getByText('Open in new window')).toBeInTheDocument();
    expect(screen.getByText('Close tab')).toBeInTheDocument();
  });
});

describe('PaneArea — two panes', () => {
  it('each pane draws its own tab bar even with one tab each, and clicking one focuses it', () => {
    seedChats(['c1', 'c2']);
    const layout = useLayoutStore.getState();
    layout.openTab({ kind: 'chat', chatId: 'c1' });
    layout.openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'split', edge: 'right' });
    renderPanes();

    expect(screen.getAllByRole('tablist', { name: 'Tabs' })).toHaveLength(2);

    const split = useLayoutStore.getState().root as SplitPane;
    const leftPaneId = split.children[0]!.pane.id;
    expect(useLayoutStore.getState().activePaneId).not.toBe(leftPaneId);

    fireEvent.pointerDown(screen.getByTestId(`pane-${leftPaneId}`));
    expect(useLayoutStore.getState().activePaneId).toBe(leftPaneId);
  });
});

describe('PaneArea — regressions found using it', () => {
  it('splitting the only pane while it is on screen does not break the render', () => {
    seedChats(['c1', 'c2']);
    const layout = useLayoutStore.getState();
    layout.openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    layout.openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPanes();
    act(() => {
      const l = useLayoutStore.getState();
      l.splitActivePane(l.activePaneId, 'right');
    });
    expect(screen.getAllByRole('tablist', { name: 'Tabs' })).toHaveLength(2);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a tab title follows its chat being renamed', () => {
    seedChats(['c1', 'c2']);
    const layout = useLayoutStore.getState();
    layout.openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    layout.openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    renderPanes();
    expect(screen.getAllByRole('tab')[0]).toHaveTextContent('c1');
    act(() => {
      useChatStore.getState().setName('c1', 'Renamed');
    });
    expect(screen.getAllByRole('tab')[0]).toHaveTextContent('Renamed');
  });

  it('a tab is not a button wrapping another button', () => {
    seedChats(['c1', 'c2']);
    const layout = useLayoutStore.getState();
    layout.openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    layout.openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    renderPanes();
    expect(document.querySelector('button button')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Close tab' })).toHaveLength(2);
  });

  it('dropping the first tab on the right half of the second lands it second, not last', () => {
    seedChats(['c1', 'c2', 'c3']);
    const layout = useLayoutStore.getState();
    for (const id of ['c1', 'c2', 'c3'])
      layout.openTab({ kind: 'chat', chatId: id }, { placement: 'tab' });
    renderPanes();
    const pane = useLayoutStore.getState().root as LeafPane;
    const payload = JSON.stringify({ paneId: pane.id, tabId: pane.tabs[0]!.id });
    fireEvent.drop(screen.getByTestId(`tab-${pane.tabs[1]!.id}`), {
      clientX: 10,
      dataTransfer: { getData: () => payload, types: ['application/x-patch-tab'] },
    });
    const after = useLayoutStore.getState().root as LeafPane;
    expect(after.tabs.map((t) => cid(t.descriptor))).toEqual(['c2', 'c1', 'c3']);
  });

  describe('dragging a tab out of the window', () => {
    function setup() {
      seedChats(['c1', 'c2']);
      const layout = useLayoutStore.getState();
      for (const id of ['c1', 'c2'])
        layout.openTab({ kind: 'chat', chatId: id }, { placement: 'tab' });
      renderPanes();
      const pane = useLayoutStore.getState().root as LeafPane;
      return { pane, tab: screen.getByTestId(`tab-${pane.tabs[0]!.id}`) };
    }
    // jsdom has no DragEvent, so the pointer position and dataTransfer are
    // set on a plain event the way a browser's dragend would carry them.
    const dragEnd = (el: HTMLElement, dropEffect: string, clientX: number, clientY: number) => {
      const ev = createEvent.dragEnd(el);
      Object.assign(ev, { clientX, clientY, dataTransfer: { dropEffect, types: [] } });
      fireEvent(el, ev);
    };

    beforeEach(() => openTabInNewWindow.mockClear());

    it('an undropped drag ending outside the window detaches the tab into a new window', () => {
      const { pane, tab } = setup();
      dragEnd(tab, 'none', -40, 300);
      expect(openTabInNewWindow).toHaveBeenCalledWith({ kind: 'chat', chatId: 'c1' });
      const after = useLayoutStore.getState().root as LeafPane;
      expect(after.tabs.map((t) => cid(t.descriptor))).toEqual(['c2']);
      expect(pane.tabs).toHaveLength(2);
    });

    it('a drag released over the window never detaches', () => {
      const { tab } = setup();
      dragEnd(tab, 'none', 100, 100);
      expect(openTabInNewWindow).not.toHaveBeenCalled();
    });

    it('an accepted drop never detaches, wherever the pointer reads', () => {
      const { tab } = setup();
      dragEnd(tab, 'move', -40, 300);
      expect(openTabInNewWindow).not.toHaveBeenCalled();
      expect((useLayoutStore.getState().root as LeafPane).tabs).toHaveLength(2);
    });
  });
});

describe('PaneArea — moving a tab keeps it mounted', () => {
  it('moving a tab to another pane or splitting it out does not remount its content', () => {
    seedChats(['c1']);
    settingsMounts.count = 0;
    useLayoutStore.getState().openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    useLayoutStore.getState().openTab({ kind: 'page', page: 'settings' }, { placement: 'tab' });
    const first = useLayoutStore.getState().root as LeafPane;
    const settingsTab = first.tabs.find((t) => t.descriptor.kind === 'page')!;
    renderPanes();
    expect(settingsMounts.count).toBe(1);

    act(() => useLayoutStore.getState().splitWithTab(first.id, settingsTab.id, first.id, 'right'));
    expect(screen.getByTestId('settings-stub')).toBeInTheDocument();
    const split = useLayoutStore.getState().root as SplitPane;
    const rightId = split.children[1]!.pane.id;
    expect(screen.getByTestId(`pane-content-${rightId}`)).toContainElement(
      screen.getByTestId('settings-stub'),
    );
    expect(settingsMounts.count).toBe(1);

    act(() => useLayoutStore.getState().moveTab(rightId, settingsTab.id, first.id, 0));
    expect(screen.getByTestId(`pane-content-${first.id}`)).toContainElement(
      screen.getByTestId('settings-stub'),
    );
    expect(settingsMounts.count).toBe(1);
  });
});

describe('PaneArea — StrictMode (the dev app and the e2e harness both run in it)', () => {
  it("shows the tab's content in its pane after the double mount, and still after a move", () => {
    seedChats(['c1']);
    useLayoutStore.getState().openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    useLayoutStore.getState().openTab({ kind: 'page', page: 'settings' }, { placement: 'tab' });
    const first = useLayoutStore.getState().root as LeafPane;
    const settingsTab = first.tabs.find((t) => t.descriptor.kind === 'page')!;
    renderPanes({ strict: true });
    expect(screen.getByTestId(`pane-content-${first.id}`)).toContainElement(
      screen.getByTestId('settings-stub'),
    );

    act(() => useLayoutStore.getState().splitWithTab(first.id, settingsTab.id, first.id, 'right'));
    const rightId = (useLayoutStore.getState().root as SplitPane).children[1]!.pane.id;
    expect(screen.getByTestId(`pane-content-${rightId}`)).toContainElement(
      screen.getByTestId('settings-stub'),
    );
  });
});

describe('PaneArea — remount between routes', () => {
  it('keeps the tab content on screen when one route hands the same tab to another PaneArea', async () => {
    seedChats(['c1']);
    useLayoutStore.getState().openTab({ kind: 'page', page: 'settings' }, { placement: 'tab' });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Two PaneAreas swapping in one commit: the outgoing one's deferred cleanup
    // must not pull the host out from under the incoming one.
    function Swap(): JSX.Element {
      const [on, setOn] = useState(true);
      return (
        <QueryClientProvider client={qc}>
          <MemoryRouter>
            <button type="button" onClick={() => setOn(false)}>
              swap
            </button>
            {on ? (
              <div key="a">
                <PaneArea ws={null} />
              </div>
            ) : (
              <section key="b">
                <PaneArea ws={null} />
              </section>
            )}
          </MemoryRouter>
        </QueryClientProvider>
      );
    }
    render(<Swap />);
    fireEvent.click(screen.getByText('swap'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('settings-stub')).toBeInTheDocument();
    expect(document.body).toContainElement(screen.getByTestId('settings-stub'));
  });
});

describe('PaneArea — groups (spec/14 § Groups)', () => {
  it('every group is a card whose header is the chat header; the number shows with several groups', () => {
    seedChats(['a', 'b']);
    useLayoutStore.getState().showChat('a');
    renderPanes();
    expect(screen.getAllByTestId('chat-head')).toHaveLength(1);
    expect(screen.getByTestId('chat-head')).toHaveClass('chat-head-group');
    expect(screen.getByTestId('chat-head').closest('.group-card-framed')).not.toBeNull();
    expect(screen.queryByTestId('group-num')).toBeNull();
    expect(screen.queryByTestId('group-close')).toBeNull();

    act(() => useLayoutStore.getState().showChat('b', { newGroup: true }));
    expect(screen.getAllByTestId('chat-head')).toHaveLength(2);
    expect(screen.getAllByTestId('group-num').map((n) => n.textContent)).toEqual(['1', '2']);
    expect(screen.getAllByTestId('chat-title').map((n) => n.textContent)).toEqual(['a', 'b']);
  });

  it('the group header carries Files, Browser, Editor and Terminal, each toggling its tab', () => {
    seedChats(['a']);
    useLayoutStore.getState().showChat('a');
    renderPanes();
    for (const id of ['files', 'browser', 'editor', 'terminal']) {
      expect(screen.getByTestId(`group-tool-${id}`)).toHaveAttribute('aria-pressed', 'false');
    }
    fireEvent.click(screen.getByTestId('group-tool-terminal'));
    expect(screen.getByTestId('group-tool-terminal')).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('tablist', { name: 'Tabs' }).querySelectorAll('[role="tab"]'),
    ).toHaveLength(2);
    fireEvent.click(screen.getByTestId('group-tool-terminal'));
    expect(screen.getByTestId('group-tool-terminal')).toHaveAttribute('aria-pressed', 'false');
  });

  it('the + at the end of the tab row opens a menu whose items open ordinary tabs', () => {
    seedChats(['a']);
    useLayoutStore.getState().showChat('a');
    renderPanes();
    const bar = screen.getByRole('tablist', { name: 'Tabs' });
    fireEvent.click(bar.querySelector('.pane-tab-new')!);
    fireEvent.click(screen.getByRole('menuitem', { name: /Browser/ }));
    expect(screen.getByTestId('group-tool-browser')).toHaveAttribute('aria-pressed', 'true');
  });

  it('only the focused group is marked focused', () => {
    seedChats(['a', 'b']);
    useLayoutStore.getState().showChat('a');
    useLayoutStore.getState().showChat('b', { newGroup: true });
    renderPanes();
    const cards = document.querySelectorAll('.group-card');
    expect(Array.from(cards).map((c) => c.getAttribute('data-focused'))).toEqual(['false', 'true']);
    expect(cards[1]).toHaveClass('group-card-focused');
  });

  it('closing a group from its card removes it', () => {
    seedChats(['a', 'b']);
    useLayoutStore.getState().showChat('a');
    useLayoutStore.getState().showChat('b', { newGroup: true });
    renderPanes();
    fireEvent.click(screen.getAllByTestId('group-close')[1]!);
    expect(useLayoutStore.getState().groups.map((g) => g.chatId)).toEqual(['a']);
  });

  it('shows only the focused group when the row cannot fit them all', () => {
    seedChats(['a', 'b']);
    useLayoutStore.getState().showChat('a');
    useLayoutStore.getState().showChat('b', { newGroup: true });
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 700, height: 600 } as DOMRect);
    renderPanes();
    expect(screen.getAllByTestId('chat-head')).toHaveLength(1);
    expect(screen.getByTestId('chat-title').textContent).toBe('b');
    spy.mockRestore();
  });
});
