// PaneArea — the VS Code-style pane/tab layout of the main area (spec/14 §
// Panes and tabs). Recursively renders the `layoutStore` tree: a split node
// becomes a row/column of resizable children, a leaf node becomes a tab bar
// plus whatever its active tab is showing.
//
// Stage 1 (spec/14 § Panes and tabs): the only tab kind is a chat. Files,
// terminals and pages join as later stages extend `TabDescriptor`
// (`stores/layoutStore.ts`) and the `TabContent` switch below.

import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  DragEvent as ReactDragEvent,
  JSX,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/rest.js';
import {
  ExternalLink,
  Files,
  Globe,
  FolderTree,
  PanelRightOpen,
  Settings as SettingsIcon,
  TerminalSquare,
  Layers,
} from 'lucide-react';
import {
  GROUP_COLOURS,
  MIN_GROUP_WIDTH_PX,
  countPanes,
  firstLeaf,
  isTabDirty,
  useLayoutStore,
  type Group,
  type LeafPane,
  type PaneNode,
  type SplitEdge,
  type Tab,
  type TabDescriptor,
} from '../stores/layoutStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { deriveChatTitle } from '../lib/chatTitle.js';
import { stripMarkdown } from '../lib/stripMarkdown.js';
import { StatusBadge } from './StatusBadge.js';
import { useChatBadge } from './ChatStatusBadge.js';
import { openTabInNewWindow } from '../lib/newWindow.js';
import { CloseIcon } from './icons.js';
import { shortcutTitle, useActionGlyphs } from '../lib/shortcuts.js';
import { ChatRoute } from '../routes/ChatRoute.js';
import { SideThreadsPanel } from './SideThreadsPanel.js';
import { FileEditorTab } from './FileEditorTab.js';
import { FilesPage } from './FilesPage.js';
import { HostFilesPage } from './HostFilesPage.js';
import { JobsRoute } from '../routes/JobsRoute.js';
import { JobEditorRoute } from '../routes/JobEditorRoute.js';
import { SettingsRoute } from '../routes/SettingsRoute.js';
import { TerminalPanel } from './TerminalPanel.js';
import { BrowserView } from './BrowserView.js';
import { PadsPage } from './PadsPage.js';
import { PadPane } from './PadPane.js';
import { NewPadPage } from './NewPadPage.js';
import type { PatchWs } from '../api/ws.js';
import { useContextMenu, ContextMenu, type ContextMenuItem } from './ContextMenu.js';

/** The custom MIME type a tab drag carries — `{ paneId, tabId }` JSON. Not
 *  `text/plain`: that would let a tab title be "dropped" as text anywhere
 *  else the browser accepts a text drop (a composer, an address bar). */
const TAB_DRAG_TYPE = 'application/x-patch-tab';

interface DragPayload {
  paneId: string;
  tabId: string;
}

function readDragPayload(e: { dataTransfer: DataTransfer | null }): DragPayload | null {
  const raw = e.dataTransfer?.getData(TAB_DRAG_TYPE);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as DragPayload).paneId === 'string' &&
      typeof (parsed as DragPayload).tabId === 'string'
    ) {
      return parsed as DragPayload;
    }
  } catch {
    /* not a tab drag */
  }
  return null;
}

/** A chat's own summarised name (spec/14 § Sidebar), or `Manager` for the
 *  special thread, matching the sidebar's own rule. */
function chatTitle(chatId: string, name: string | null | undefined): string {
  if (chatId === SPECIAL_THREAD_IDS.manager) return 'Manager';
  return stripMarkdown(deriveChatTitle(name ?? null));
}

/** The chat a tab is about, if any — whose row drives the tab's title and badge. */
function tabChatId(d: TabDescriptor): string | null {
  return d.kind === 'chat' || d.kind === 'terminal' || d.kind === 'file'
    ? d.chatId
    : d.kind === 'page' && d.page === 'files'
      ? d.chatId
      : null;
}

/** A tab's display title — per kind (spec/14 § Panes and tabs). `jobs` is the
 *  `['jobs']` cache `JobsRoute`/`JobEditorRoute` already populate, read only
 *  for a job tab's name. */
function tabTitle(
  tab: Tab,
  chatName: string | null | undefined,
  jobs: { jobs: { id: string; name: string }[] } | undefined,
  padName?: string,
): string {
  const d = tab.descriptor;
  switch (d.kind) {
    case 'chat':
      return chatTitle(d.chatId, chatName);
    case 'terminal':
      return `Terminal — ${chatTitle(d.chatId, chatName)}`;
    case 'browser':
      return `Browser — ${chatTitle(d.chatId, chatName)}`;
    case 'file':
      return d.path.includes('/') ? d.path.slice(d.path.lastIndexOf('/') + 1) : d.path;
    case 'page':
      switch (d.page) {
        case 'jobs':
          return 'Jobs';
        case 'job': {
          if (d.jobId === 'new') return 'New job';
          return jobs?.jobs.find((j) => j.id === d.jobId)?.name ?? 'Job';
        }
        case 'settings':
          return 'Settings';
        case 'files':
          return `Files — ${chatTitle(d.chatId, chatName)}`;
        case 'host-files':
          return 'Host files';
        case 'pads':
          return 'Pads';
        case 'pad':
          return padName ?? 'Pad';
        case 'new-pad':
          return 'New Pad';
      }
  }
}

/** Icon for a tab's kind (spec/14 § Panes and tabs) — a chat tab draws its
 *  status badge instead (see `TabBar`), so this never covers that case. */
function tabIcon(d: TabDescriptor): JSX.Element | null {
  switch (d.kind) {
    case 'chat':
      return null;
    case 'terminal':
      return <TerminalSquare size={13} aria-hidden />;
    case 'browser':
      return <Globe size={13} aria-hidden />;
    case 'file':
      return <Files size={13} aria-hidden />;
    case 'page':
      switch (d.page) {
        case 'jobs':
        case 'job':
          return <FolderTree size={13} aria-hidden />;
        case 'settings':
          return <SettingsIcon size={13} aria-hidden />;
        case 'files':
        case 'host-files':
          return <Files size={13} aria-hidden />;
        case 'pads':
        case 'pad':
        case 'new-pad':
          return <Layers size={13} aria-hidden />;
      }
  }
}

// Tab content is mounted ONCE per tab, in `PaneArea`, into a detached host
// element that belongs to the tab. The pane it is shown in only adopts that
// element into its content slot. Moving a tab to another pane or splitting it
// out therefore moves a DOM node instead of unmounting and remounting the
// content, so a chat, terminal or editor keeps its state.
const tabHostEls = new Map<string, HTMLElement>();
const tabHostUsers = new Map<HTMLElement, number>();

function tabHostEl(tabId: string): HTMLElement {
  let el = tabHostEls.get(tabId);
  if (!el) {
    el = document.createElement('div');
    el.className = 'tab-host';
    el.style.display = 'contents';
    tabHostEls.set(tabId, el);
  }
  return el;
}

function activeLeafTabs(node: PaneNode, out: { pane: LeafPane; tab: Tab }[] = []) {
  if (node.type === 'leaf') {
    const tab = node.tabs.find((t) => t.id === node.activeTabId);
    if (tab) out.push({ pane: node, tab });
  } else {
    for (const c of node.children) activeLeafTabs(c.pane, out);
  }
  return out;
}

function HostedTab({
  tab,
  hostKey,
  focused,
  ws,
}: {
  tab: Tab;
  /** `groupId:tabId` — the same tab can be open in two groups at once. */
  hostKey: string;
  focused: boolean;
  ws: PatchWs | null;
}): JSX.Element {
  const el = tabHostEl(hostKey);
  useLayoutEffect(() => {
    tabHostUsers.set(el, (tabHostUsers.get(el) ?? 0) + 1);
    return () => {
      tabHostUsers.set(el, (tabHostUsers.get(el) ?? 1) - 1);
      // Deferred so StrictMode's simulated unmount/remount, which runs in the
      // same task, doesn't tear down the host the portal is still rendering into.
      // Counted per element, not per instance: a PaneArea that remounts (a route
      // change) hands the same host to a new HostedTab before this runs.
      queueMicrotask(() => {
        if ((tabHostUsers.get(el) ?? 0) > 0) return;
        tabHostUsers.delete(el);
        el.remove();
        if (tabHostEls.get(hostKey) === el) tabHostEls.delete(hostKey);
      });
    };
  }, [el, hostKey]);
  return createPortal(<TabContent tab={tab} focused={focused} ws={ws} />, el);
}

/** Which group a pane is being drawn in. */
interface GroupView {
  group: Group;
  /** The group has the user's focus. */
  focused: boolean;
}
const GroupCtx = createContext<GroupView | null>(null);

function useGroupView(): GroupView {
  const v = useContext(GroupCtx);
  if (!v) throw new Error('pane rendered outside a group');
  return v;
}

/** Colour slot (1..GROUP_COLOURS) of the group at `index` — the sidebar's
 *  number chip and the group card share it. */
export function groupColourClass(index: number): string {
  return `g${(index % GROUP_COLOURS) + 1}`;
}

export function PaneArea({ ws }: { ws: PatchWs | null }): JSX.Element {
  const groups = useLayoutStore((s) => s.groups);
  const focusedGroupId = useLayoutStore((s) => s.focusedGroupId);
  const resizeGroups = useLayoutStore((s) => s.resizeGroups);
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const measure = (): void => setRowWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // When the row cannot give every group its minimum width, only the focused
  // group is shown; the rest stay reachable from their sidebar numbers
  // (spec/14 § Groups). Before the first measure everything is shown.
  const fits = rowWidth === 0 || groups.length * MIN_GROUP_WIDTH_PX <= rowWidth;
  const visible = fits ? groups : groups.filter((g) => g.id === focusedGroupId);
  const cards = groups.length > 1;
  const minFraction = rowWidth > 0 ? MIN_GROUP_WIDTH_PX / rowWidth : 0;

  return (
    <div
      ref={rowRef}
      className={`group-row${cards ? ' group-row-cards' : ''}`}
      data-testid="group-row"
    >
      {visible.map((group, i) => {
        const index = groups.indexOf(group);
        const focused = group.id === focusedGroupId;
        const active = activeLeafTabs(group.root);
        return (
          <Fragment key={group.id}>
            {i > 0 ? (
              <PaneDividerHandle
                direction="row"
                onResize={(delta) => resizeGroups(index - 1, delta, minFraction)}
              />
            ) : null}
            <GroupCtx.Provider value={{ group, focused }}>
              <GroupCard
                group={group}
                index={index}
                cards={cards}
                focused={focused}
                size={fits ? group.size : 1}
              >
                <PaneNodeView node={group.root} ws={ws} totalPanes={countPanes(group.root)} />
              </GroupCard>
              {active.map(({ pane, tab }) => (
                <HostedTab
                  key={`${group.id}:${tab.id}`}
                  hostKey={`${group.id}:${tab.id}`}
                  tab={tab}
                  focused={focused && pane.id === group.activePaneId}
                  ws={ws}
                />
              ))}
            </GroupCtx.Provider>
          </Fragment>
        );
      })}
    </div>
  );
}

function GroupCard({
  group,
  index,
  cards,
  focused,
  size,
  children,
}: {
  group: Group;
  index: number;
  cards: boolean;
  focused: boolean;
  size: number;
  children: ReactNode;
}): JSX.Element {
  const focusGroup = useLayoutStore((s) => s.focusGroup);
  const closeGroup = useLayoutStore((s) => s.closeGroup);
  const chat = useChatStore((s) => (group.chatId ? s.chats[group.chatId] : undefined));
  const name = group.chatId === null ? 'Empty group' : chatTitle(group.chatId, chat?.name);
  const colour = groupColourClass(index);
  return (
    <section
      className={`group-card ${colour}${cards ? ' group-card-framed' : ''}${focused ? ' group-card-focused' : ''}`}
      style={{ flexGrow: size, flexBasis: 0 }}
      data-testid={`group-${group.id}`}
      data-group-index={index + 1}
      data-focused={focused}
      onPointerDownCapture={() => {
        if (!focused) focusGroup(group.id);
      }}
    >
      {cards ? (
        <header className="group-head" data-testid="group-head">
          <span className="group-name">
            <span className="group-num" data-testid="group-num">
              {index + 1}
            </span>
            <span className="group-title">{name}</span>
          </span>
          <button
            type="button"
            className="group-close"
            aria-label="Close group"
            title="Close group"
            data-testid="group-close"
            onClick={() => closeGroup(group.id)}
          >
            <CloseIcon size={14} />
          </button>
        </header>
      ) : null}
      <div className="group-body">{children}</div>
    </section>
  );
}

function PaneNodeView({
  node,
  ws,
  totalPanes,
}: {
  node: PaneNode;
  ws: PatchWs | null;
  totalPanes: number;
}): JSX.Element {
  const resizeSplit = useLayoutStore((s) => s.resizeSplit);
  if (node.type === 'leaf') return <Pane pane={node} totalPanes={totalPanes} />;
  return (
    <div
      className={`pane-split pane-split-${node.direction}`}
      data-testid={`pane-split-${node.id}`}
    >
      {node.children.map((child, i) => (
        <Fragment key={child.pane.id}>
          {i > 0 ? (
            <PaneDividerHandle
              direction={node.direction}
              onResize={(delta) => resizeSplit(node.id, i - 1, delta)}
            />
          ) : null}
          <div
            className="pane-split-child"
            style={{ flexGrow: child.size, flexBasis: 0, flexShrink: 1, minWidth: 0, minHeight: 0 }}
          >
            <PaneNodeView node={child.pane} ws={ws} totalPanes={totalPanes} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

// Thin wrapper so `PaneDivider` (a shared, presentation-only component) isn't
// imported twice under two names in the same file.
import { PaneDivider as PaneDividerHandle } from './PaneDivider.js';

function Pane({ pane, totalPanes }: { pane: LeafPane; totalPanes: number }): JSX.Element {
  const { group, focused: groupFocused } = useGroupView();
  const setActivePane = useLayoutStore((s) => s.setActivePane);
  const moveTab = useLayoutStore((s) => s.moveTab);
  const splitWithTab = useLayoutStore((s) => s.splitWithTab);
  const focused = groupFocused && group.activePaneId === pane.id;
  const [dropEdge, setDropEdge] = useState<SplitEdge | 'center' | null>(null);
  // `onDrop` reads this REF, not the `dropEdge` state above: a native drag
  // fires `dragover` and `drop` back-to-back, synchronously, often before
  // React has re-rendered (and so re-attached `onContentDrop`'s callback)
  // off the `setDropEdge` call the LAST `dragover` made — `onDrop` would then
  // still be running the closure from the dragover before that, one zone
  // behind the one actually drawn on screen. A ref has no such lag: it is
  // written and read synchronously, outside React's render cycle, so `onDrop`
  // always sees the zone from the dragover that JUST fired. The state is kept
  // only to drive the visible highlight — `.pane-dropzone` below.
  const dropEdgeRef = useRef<SplitEdge | 'center' | null>(null);

  // NATIVE listeners, not React's: the tab's content is portalled in
  // (`HostedTab`), so a drop on it bubbles through the DOM to this pane but
  // through React to `PaneArea`, and a React `onDrop` here never heard it.
  const contentRef = useRef<HTMLDivElement>(null);
  const onContentDragOver = useCallback((e: DragEvent): void => {
    if (!e.dataTransfer?.types.includes(TAB_DRAG_TYPE)) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const EDGE = 0.25;
    let zone: SplitEdge | 'center' = 'center';
    if (x < EDGE) zone = 'left';
    else if (x > 1 - EDGE) zone = 'right';
    else if (y < EDGE) zone = 'top';
    else if (y > 1 - EDGE) zone = 'bottom';
    dropEdgeRef.current = zone;
    setDropEdge(zone);
  }, []);

  const onContentDragLeave = useCallback((e: DragEvent): void => {
    if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) return;
    dropEdgeRef.current = null;
    setDropEdge(null);
  }, []);

  const onContentDrop = useCallback(
    (e: DragEvent): void => {
      const payload = readDragPayload(e);
      const edge = dropEdgeRef.current;
      dropEdgeRef.current = null;
      setDropEdge(null);
      if (!payload) return;
      e.preventDefault();
      if (edge === 'center' || edge === null) {
        moveTab(payload.paneId, payload.tabId, pane.id, pane.tabs.length);
      } else {
        splitWithTab(payload.paneId, payload.tabId, pane.id, edge);
      }
    },
    [moveTab, splitWithTab, pane.id, pane.tabs.length],
  );
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    el.addEventListener('dragover', onContentDragOver);
    el.addEventListener('dragleave', onContentDragLeave);
    el.addEventListener('drop', onContentDrop);
    return () => {
      el.removeEventListener('dragover', onContentDragOver);
      el.removeEventListener('dragleave', onContentDragLeave);
      el.removeEventListener('drop', onContentDrop);
    };
  }, [onContentDragOver, onContentDragLeave, onContentDrop]);

  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? null;
  // A single pane holding a single tab is the common case — today's plain
  // chat view — and draws no tab bar at all (spec/14 § Panes and tabs): there
  // is nothing yet to switch between, reorder, or move. The bar earns its
  // place the moment there's a second tab, anywhere, or a second pane.
  const showTabBar = pane.tabs.length > 1 || totalPanes > 1;
  // The pane in the window's top-left corner: its tab bar is the row the
  // desktop shell's window controls float over (spec/05 § Window chrome).
  const isOrigin = useLayoutStore(
    (s) => s.groups[0]?.id === group.id && firstLeaf(group.root).id === pane.id,
  );

  return (
    <div
      className={`pane${focused ? ' pane-focused' : ''}${isOrigin ? ' pane-origin' : ''}`}
      data-testid={`pane-${pane.id}`}
      onPointerDownCapture={() => {
        if (!focused) setActivePane(pane.id);
      }}
    >
      {showTabBar ? <TabBar pane={pane} focused={focused} /> : null}
      <div ref={contentRef} className="pane-content" data-testid={`pane-content-${pane.id}`}>
        {dropEdge ? (
          <div className={`pane-dropzone pane-dropzone-${dropEdge}`} data-testid="pane-dropzone" />
        ) : null}
        {activeTab ? (
          <TabSlot tabId={`${group.id}:${activeTab.id}`} />
        ) : (
          <div className="pane-empty" data-testid="pane-empty">
            No tabs open
          </div>
        )}
      </div>
    </div>
  );
}

/** Adopts the tab's persistent host element (see `HostedTab`) into this pane. */
function TabSlot({ tabId }: { tabId: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    const host = tabHostEl(tabId);
    // Moving an element out of the document drops focus inside it: never re-append
    // one that is already here, and give the cursor back when it really moves panes.
    if (!slot || host.parentElement === slot) return;
    const focused = document.activeElement;
    slot.appendChild(host);
    if (
      focused instanceof HTMLElement &&
      focused !== document.activeElement &&
      host.contains(focused)
    ) {
      focused.focus({ preventScroll: true });
    }
  }, [tabId]);
  return <div ref={ref} className="tab-slot" style={{ display: 'contents' }} />;
}

function TabContent({
  tab,
  focused,
  ws,
}: {
  tab: Tab;
  focused: boolean;
  ws: PatchWs | null;
}): JSX.Element {
  const clearPendingSeq = useLayoutStore((s) => s.clearPendingSeq);
  const d = tab.descriptor;
  switch (d.kind) {
    case 'chat':
      return (
        <div className="chat-tab-host">
          <ChatRoute
            ws={ws}
            chatId={d.chatId}
            focused={focused}
            initialSeq={tab.pendingSeq ?? null}
            onSeqConsumed={() => clearPendingSeq(tab.id)}
          />
          <SideThreadsPanel hostChatId={d.chatId} />
        </div>
      );
    case 'terminal': {
      const folder = useChatStore.getState().chats[d.chatId]?.folder ?? '';
      return <TerminalPanel chatId={d.chatId} folder={folder} ws={ws} focused={focused} />;
    }
    case 'file':
      return (
        <FileEditorTab chatId={d.chatId} path={d.path} tabId={tab.id} focused={focused} ws={ws} />
      );
    case 'browser':
      return <BrowserView chatId={d.chatId} layout="pane" />;
    case 'page':
      switch (d.page) {
        case 'jobs':
          return <JobsRoute />;
        case 'job':
          return <JobEditorRoute jobId={d.jobId} />;
        case 'settings':
          return <SettingsRoute />;
        case 'files':
          return <FilesPage chatId={d.chatId} />;
        case 'host-files':
          return <HostFilesPage ws={ws} />;
        case 'pads':
          return <PadsPage />;
        case 'pad':
          return <PadPane padId={d.padId} />;
        case 'new-pad':
          return <NewPadPage chatId={d.chatId} />;
      }
  }
}

function TabBar({ pane, focused }: { pane: LeafPane; focused: boolean }): JSX.Element {
  const setActiveTab = useLayoutStore((s) => s.setActiveTab);
  const setActivePane = useLayoutStore((s) => s.setActivePane);
  const closeTab = useLayoutStore((s) => s.closeTab);
  const closePane = useLayoutStore((s) => s.closePane);
  const multiplePanes = useGroupView().group.root.type === 'split';
  const reorderTab = useLayoutStore((s) => s.reorderTab);
  const moveTab = useLayoutStore((s) => s.moveTab);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const menu = useContextMenu();
  const [menuTab, setMenuTab] = useState<Tab | null>(null);

  return (
    <div
      className="pane-tab-bar"
      role="tablist"
      aria-label="Tabs"
      data-testid={`tab-bar-${pane.id}`}
    >
      {pane.tabs.map((tab) => (
        <PaneTab
          key={tab.id}
          tab={tab}
          active={tab.id === pane.activeTabId}
          dragOver={dragOverId === tab.id}
          onActivate={() => {
            setActivePane(pane.id);
            setActiveTab(pane.id, tab.id);
          }}
          onClose={() => closeTab(pane.id, tab.id)}
          onContextMenu={(e) => {
            setMenuTab(tab);
            menu.openAt(e);
          }}
          onDragStart={(e) => {
            e.dataTransfer.setData(
              TAB_DRAG_TYPE,
              JSON.stringify({ paneId: pane.id, tabId: tab.id }),
            );
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer?.types.includes(TAB_DRAG_TYPE)) return;
            e.preventDefault();
            setDragOverId(tab.id);
          }}
          onDragLeave={() => setDragOverId((cur) => (cur === tab.id ? null : cur))}
          onDrop={(e) => {
            const payload = readDragPayload(e);
            setDragOverId(null);
            if (!payload) return;
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            const before = e.clientX < rect.left + rect.width / 2;
            const targetIndex = pane.tabs.findIndex((t) => t.id === tab.id);
            // The gap the pointer is over, counted in the bar as it stands.
            const gap = before ? targetIndex : targetIndex + 1;
            if (payload.paneId === pane.id) {
              // `reorderTab` takes the tab's FINAL index, after it has left
              // its old slot — a tab moving right sees every index drop by one.
              const from = pane.tabs.findIndex((t) => t.id === payload.tabId);
              reorderTab(pane.id, payload.tabId, from !== -1 && from < gap ? gap - 1 : gap);
            } else moveTab(payload.paneId, payload.tabId, pane.id, gap);
          }}
          onDragEnd={(e) => {
            setDragOverId(null);
            // Released over nothing that accepts a tab, outside the window:
            // the tab leaves for a window of its own (spec/14 § Panes and tabs).
            const outside =
              e.clientX < 0 ||
              e.clientY < 0 ||
              e.clientX > window.innerWidth ||
              e.clientY > window.innerHeight;
            if (e.dataTransfer.dropEffect === 'none' && outside) {
              openTabInNewWindow(tab.descriptor);
              closeTab(pane.id, tab.id);
            }
          }}
        />
      ))}
      {/* Trailing drop catch-all: dropping past the last tab appends there,
          without needing to land exactly on a tab. */}
      <div
        className={`pane-tab-bar-fill${focused ? ' focused' : ''}`}
        data-testid={`tab-bar-fill-${pane.id}`}
        onDragOver={(e) => {
          if (!e.dataTransfer?.types.includes(TAB_DRAG_TYPE)) return;
          e.preventDefault();
        }}
        onDrop={(e) => {
          const payload = readDragPayload(e);
          if (!payload) return;
          e.preventDefault();
          if (payload.paneId === pane.id) reorderTab(pane.id, payload.tabId, pane.tabs.length);
          else moveTab(payload.paneId, payload.tabId, pane.id, pane.tabs.length);
        }}
      />
      {multiplePanes && (
        <button
          type="button"
          className="pane-tab-close pane-close"
          aria-label="Close pane"
          data-testid={`pane-close-${pane.id}`}
          onClick={() => closePane(pane.id)}
        >
          ×
        </button>
      )}
      <ContextMenu
        anchor={menu.anchor}
        items={menuTab ? tabContextItems(menuTab, pane) : []}
        onClose={() => {
          menu.close();
          setMenuTab(null);
        }}
        label="Tab actions"
        testId={`tab-menu-${pane.id}`}
      />
    </div>
  );
}

interface PaneTabProps {
  tab: Tab;
  active: boolean;
  dragOver: boolean;
  onActivate: () => void;
  onClose: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  onDragStart: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDragOver: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDragEnd: (e: ReactDragEvent<HTMLDivElement>) => void;
}

/** One tab. Subscribes to its own chat's row and the jobs cache so the title
 *  and status badge stay live — they are read where they render, never from a
 *  one-off `getState()` that would freeze them at the last unrelated render. */
function PaneTab({ tab, active, dragOver, ...on }: PaneTabProps): JSX.Element {
  const closeTabGlyphs = useActionGlyphs('closeTab');
  const chatId = tabChatId(tab.descriptor);
  const row = useChatStore((s) => (chatId ? s.chats[chatId] : undefined));
  const isJob = tab.descriptor.kind === 'page' && tab.descriptor.page === 'job';
  const { data: jobs } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.listJobs() as Promise<{ jobs: { id: string; name: string }[] }>,
    enabled: isJob,
  });
  const chatBadge = useChatBadge(row);
  const badge = tab.descriptor.kind === 'chat' ? chatBadge : null;
  const padId =
    tab.descriptor.kind === 'page' && tab.descriptor.page === 'pad' ? tab.descriptor.padId : null;
  const { data: pad } = useQuery({
    queryKey: ['pad', padId],
    queryFn: () => api.getPad(padId as string),
    enabled: padId !== null,
  });
  const title = tabTitle(tab, row?.name, jobs, pad?.name);
  const dirty = isTabDirty(tab);
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      className={`pane-tab${active ? ' active' : ''}${dragOver ? ' drag-over' : ''}`}
      data-testid={`tab-${tab.id}`}
      title={title}
      draggable
      onClick={on.onActivate}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          on.onActivate();
        }
      }}
      onAuxClick={(e) => {
        // Middle-click closes a tab (spec/14 § Panes and tabs).
        if (e.button === 1) {
          e.preventDefault();
          on.onClose();
        }
      }}
      onContextMenu={on.onContextMenu}
      onDragStart={on.onDragStart}
      onDragOver={on.onDragOver}
      onDragLeave={on.onDragLeave}
      onDrop={on.onDrop}
      onDragEnd={on.onDragEnd}
    >
      {badge ? (
        <StatusBadge
          badge={badge}
          pendingWake={row?.pendingWake ?? null}
          failureReason={row?.lastError?.message ?? null}
        />
      ) : (
        tabIcon(tab.descriptor)
      )}
      <span className="pane-tab-title">{title}</span>
      {dirty ? (
        <span
          className="pane-tab-dirty-dot"
          data-testid={`tab-dirty-${tab.id}`}
          aria-label="unsaved changes"
        />
      ) : null}
      <button
        type="button"
        tabIndex={-1}
        className="pane-tab-close"
        data-testid={`tab-close-${tab.id}`}
        aria-label="Close tab"
        title={shortcutTitle('Close tab', closeTabGlyphs)}
        onClick={(e) => {
          e.stopPropagation();
          on.onClose();
        }}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}

function tabContextItems(tab: Tab, pane: LeafPane): ContextMenuItem[] {
  const layout = useLayoutStore.getState();
  return [
    {
      id: 'split-right',
      label: 'Open to the side',
      icon: <PanelRightOpen size={14} aria-hidden />,
      run: () => layout.splitActivePane(pane.id, 'right', tab.id),
    },
    {
      id: 'new-window',
      label: 'Open in new window',
      icon: <ExternalLink size={14} aria-hidden />,
      run: () => openTabInNewWindow(tab.descriptor),
    },
    {
      id: 'close',
      label: 'Close tab',
      icon: <CloseIcon size={14} />,
      run: () => layout.closeTab(pane.id, tab.id),
    },
  ];
}
