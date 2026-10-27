// BrowserHandoffPanel — the agent's browser, in the chat (spec/14 § Browser).
// Three sizes over one live tab:
//   - the bar: "Using browser", what for (the same line the tool run shows),
//     the site, how long, Watch and Stop — for when the user does not care to see;
//   - the small preview, floating over the chat where the user drags it:
//     the live tab, who has it, and Take over / Hand back / Done;
//   - the large view (BrowserView): a pane beside the chat on a wide window,
//     the whole screen on a narrow one.
// When the agent asks for the user (`patch_browser_handoff`) the bar says so
// and the preview opens by itself. What is shown and typed travels only
// between the host and this surface; the model never sees it.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Eye, Maximize2, X } from 'lucide-react';
import { useBrowserHandoffStore } from '../stores/browserHandoffStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useLayoutStore, type PaneNode } from '../stores/layoutStore.js';
import {
  browsingSummary,
  clampPreview,
  clampPreviewWidth,
  driveState,
  formatElapsed,
  loadPreviewPosition,
  loadPreviewWidth,
  PREVIEW_DEFAULT_WIDTH,
  savePreviewPosition,
  savePreviewWidth,
  siteOf,
  viewedTab,
  type PreviewPosition,
} from '../lib/browserHandoff.js';
import { useBrowserWatch, useNow } from '../lib/browserView.js';
import { BROWSER_PANE_MIN_WINDOW, dismissBrowser, openBrowserLarge } from '../lib/browserLayout.js';
import { BrowserView, DriveAction, DriveChip, SiteTile } from './BrowserView.js';

/** A press that moves further than this is a drag of the preview, not a tap on it. */
const DRAG_SLOP_PX = 4;
const PREVIEW_MARGIN_PX = 12;

/** Whether the chat's browser tab is the one showing in its pane. */
function largeShowing(node: PaneNode, chatId: string): boolean {
  if (node.type === 'split') return node.children.some((c) => largeShowing(c.pane, chatId));
  const active = node.tabs.find((t) => t.id === node.activeTabId);
  return active?.descriptor.kind === 'browser' && active.descriptor.chatId === chatId;
}

function hasLargeTab(node: PaneNode, chatId: string): boolean {
  if (node.type === 'split') return node.children.some((c) => hasLargeTab(c.pane, chatId));
  return node.tabs.some((t) => t.descriptor.kind === 'browser' && t.descriptor.chatId === chatId);
}

function useWideWindow(): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= BROWSER_PANE_MIN_WINDOW);
  useEffect(() => {
    const on = (): void => setWide(window.innerWidth >= BROWSER_PANE_MIN_WINDOW);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return wide;
}

export function BrowserHandoffPanel({ chatId }: { chatId: string }): JSX.Element | null {
  const handoff = useBrowserHandoffStore((s) => s.handoffs[chatId]);
  const frame = useBrowserHandoffStore((s) => s.frames[chatId]);
  const status = useBrowserHandoffStore((s) => s.status[chatId]);
  const view = useBrowserHandoffStore((s) => s.views[chatId]);
  const setView = useBrowserHandoffStore((s) => s.setView);
  const timeline = useChatStore((s) => s.timelines[chatId]);
  const summaries = useChatStore((s) => s.toolRunSummaries[chatId]);
  const root = useLayoutStore((s) => s.root);
  const wide = useWideWindow();
  const paneOpen = hasLargeTab(root, chatId);
  const paneShowing = largeShowing(root, chatId);

  // The pane was closed from its tab bar: the large view is gone with it.
  useEffect(() => {
    if (view === 'large' && wide && !paneOpen) setView(chatId, undefined);
  }, [view, wide, paneOpen, chatId, setView]);

  const open = Boolean(status) || Boolean(handoff);
  const now = useNow(open && view !== 'large');
  if (!open) return null;

  const tabId = viewedTab(handoff, frame, status);
  const state = driveState(handoff, status, tabId);
  const site = siteOf(status?.tabs.find((t) => t.tabId === tabId)?.url ?? frame?.url ?? '');
  const summary = browsingSummary(timeline ?? [], summaries) ?? status?.action ?? null;
  const elapsed = status?.since !== undefined ? formatElapsed(now - status.since) : null;

  // Portalled to the body: a transformed ancestor in the chat pane would otherwise
  // become the containing block of these fixed-position layers.
  if (view === 'large' && !wide) {
    return createPortal(
      <div className="bv-screen-wrap">
        <BrowserView chatId={chatId} layout="screen" />
      </div>,
      document.body,
    );
  }
  if (view === 'mini') {
    return createPortal(
      <BrowserMini
        chatId={chatId}
        tabId={tabId}
        site={site}
        elapsed={elapsed}
        line={state === 'needs' && handoff ? handoff.reason : (summary ?? site)}
        onClose={() => setView(chatId, undefined)}
      />,
      document.body,
    );
  }
  if (view === 'large' && paneShowing) return null;

  return (
    <div className={`browser-bar is-${state}`} data-testid="browser-watch-bar">
      {site ? <SiteTile site={site} /> : null}
      <button
        type="button"
        className="browser-bar-what"
        data-testid="browser-status"
        onClick={() => (state === 'needs' ? openBrowserLarge(chatId) : setView(chatId, 'mini'))}
      >
        {state === 'needs' && handoff ? (
          <>
            <b>Needs you</b> · {handoff.reason}
          </>
        ) : (
          <>
            <b>{state === 'user' ? 'You’re using the browser' : 'Using browser'}</b>
            {summary ? <> · {summary}</> : null}
          </>
        )}
      </button>
      {site ? <span className="browser-bar-site">{site}</span> : null}
      {elapsed ? (
        <span className="browser-bar-time" data-testid="browser-elapsed">
          {elapsed}
        </span>
      ) : null}
      <span className="browser-bar-sep" aria-hidden />
      {state === 'needs' ? (
        <button
          type="button"
          className="bv-pill is-dark"
          data-testid="browser-open"
          onClick={() => openBrowserLarge(chatId)}
        >
          Open
        </button>
      ) : (
        <button
          type="button"
          className="bv-icon"
          aria-label="Watch"
          title="Watch"
          data-testid="browser-watch"
          onClick={() => setView(chatId, 'mini')}
        >
          <Eye size={16} aria-hidden />
        </button>
      )}
      <button
        type="button"
        className="bv-icon"
        aria-label="Dismiss browser"
        title="Dismiss browser"
        data-testid="browser-stop"
        onClick={() => dismissBrowser(chatId)}
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

// ---- The small preview --------------------------------------------------------

function BrowserMini({
  chatId,
  tabId,
  site,
  elapsed,
  line,
  onClose,
}: {
  chatId: string;
  tabId: string | undefined;
  site: string;
  elapsed: string | null;
  line: string;
  onClose: () => void;
}): JSX.Element {
  const frame = useBrowserHandoffStore((s) => s.frames[chatId]);
  const status = useBrowserHandoffStore((s) => s.status[chatId]);
  const handoff = useBrowserHandoffStore((s) => s.handoffs[chatId]);
  const state = driveState(handoff, status, tabId);
  const shown = frame && frame.tabId === tabId ? frame : undefined;
  const v2 = (frame?.inputVersion ?? 0) >= 2;
  useBrowserWatch(chatId, true, tabId, null);

  const cardRef = useRef<HTMLElement>(null);
  const [pos, setPos] = useState<PreviewPosition | null>(null);
  const drag = useRef<{
    id: number;
    startX: number;
    startY: number;
    from: PreviewPosition;
    moved: boolean;
  } | null>(null);
  const [width, setWidth] = useState(() =>
    clampPreviewWidth(loadPreviewWidth() ?? PREVIEW_DEFAULT_WIDTH, window.innerWidth),
  );
  const resize = useRef<{ id: number; startX: number; from: number } | null>(null);
  const size = (): { width: number; height: number } => {
    const r = cardRef.current?.getBoundingClientRect();
    return { width: r?.width ?? 0, height: r?.height ?? 0 };
  };
  const win = (): { width: number; height: number } => ({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  // First placement: where the user last left it, else the bottom right above the composer.
  useLayoutEffect(() => {
    const s = size();
    const w = win();
    const start = loadPreviewPosition() ?? {
      x: w.width - s.width - PREVIEW_MARGIN_PX - 8,
      y: w.height - s.height - 132,
    };
    setPos(clampPreview(start, s, w, PREVIEW_MARGIN_PX));
  }, []);

  // Stay on screen as the window or the picture changes size.
  useEffect(() => {
    const keep = (): void => {
      setWidth((w) => clampPreviewWidth(w, window.innerWidth));
      setPos((p) => (p ? clampPreview(p, size(), win(), PREVIEW_MARGIN_PX) : p));
    };
    window.addEventListener('resize', keep);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(keep) : null;
    if (cardRef.current) ro?.observe(cardRef.current);
    return () => {
      window.removeEventListener('resize', keep);
      ro?.disconnect();
    };
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0 || !pos) return;
    if ((e.target as HTMLElement).closest('button')) return;
    drag.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      from: pos,
      moved: false,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
    d.moved = true;
    setPos(clampPreview({ x: d.from.x + dx, y: d.from.y + dy }, size(), win(), PREVIEW_MARGIN_PX));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.moved) {
      if (pos) savePreviewPosition(pos);
    } else if ((e.target as HTMLElement).closest('.browser-mini-picture')) {
      openBrowserLarge(chatId);
    }
  };

  const onResizeDown = (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return;
    e.stopPropagation();
    resize.current = { id: e.pointerId, startX: e.clientX, from: size().width };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onResizeMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const r = resize.current;
    if (!r || r.id !== e.pointerId) return;
    e.stopPropagation();
    setWidth(clampPreviewWidth(r.from + e.clientX - r.startX, window.innerWidth));
  };
  const onResizeUp = (e: ReactPointerEvent<HTMLElement>): void => {
    const r = resize.current;
    if (!r || r.id !== e.pointerId) return;
    e.stopPropagation();
    resize.current = null;
    savePreviewWidth(width);
  };

  return (
    <section
      ref={cardRef}
      className={`browser-mini is-${state}${pos ? '' : ' is-placing'}`}
      data-testid="browser-handoff"
      aria-label="Agent browser"
      style={pos ? { left: pos.x, top: pos.y, width } : { width }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (drag.current = null)}
    >
      <header className="browser-mini-head">
        {site ? <SiteTile site={site} /> : null}
        <span className="browser-mini-site" data-testid="browser-handoff-title">
          {site || 'Browser'}
        </span>
        {elapsed ? <span className="browser-mini-time">{elapsed}</span> : null}
        <span className="browser-mini-gap" />
        <button
          type="button"
          className="bv-icon"
          aria-label="Expand browser"
          data-testid="browser-handoff-expand"
          onClick={() => openBrowserLarge(chatId)}
        >
          <Maximize2 size={14} aria-hidden />
        </button>
        <button
          type="button"
          className="bv-icon"
          aria-label="Close browser view"
          data-testid="browser-watch-close"
          onClick={onClose}
        >
          <X size={15} aria-hidden />
        </button>
      </header>
      <div className="browser-mini-picture">
        {shown ? (
          <img
            className="browser-mini-frame"
            data-testid="browser-handoff-preview"
            alt={shown.title || 'Browser tab'}
            src={`data:image/jpeg;base64,${shown.data}`}
            decoding="async"
            draggable={false}
            style={{ aspectRatio: `${shown.width} / ${shown.height}` }}
          />
        ) : (
          <p className="bv-empty" data-testid="browser-handoff-empty">
            {tabId ? 'Connecting' : 'No browser tab is open for this chat'}
          </p>
        )}
      </div>
      <footer className="browser-mini-foot">
        <DriveChip state={state} short />
        <span className="browser-mini-line" data-testid="browser-mini-line">
          {line}
        </span>
        <DriveAction
          chatId={chatId}
          tabId={tabId}
          state={state}
          handoffId={handoff?.handoffId}
          canDrive={v2}
          onTakeOver={() => openBrowserLarge(chatId)}
        />
      </footer>
      <div
        className="browser-mini-grip"
        data-testid="browser-mini-resize"
        role="separator"
        aria-label="Resize browser preview"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={() => (resize.current = null)}
      />
    </section>
  );
}
