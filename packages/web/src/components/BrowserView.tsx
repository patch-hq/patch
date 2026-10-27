// BrowserView — the chat's agent browser, large (spec/14 § Browser): a pane
// beside the chat on a wide window, the whole screen on a narrow one. One row
// of toolbar — back, forward, reload, the address, who has the tab and the one
// action that changes it, the tabs, shrink and close — over the live page.
//
// The page is the host's real Chromium, laid out at this view's size and
// pixel ratio so the picture is as sharp as the screen. Everything the user
// does in it goes to that tab: presses and releases (so a drag selects text),
// the wheel, keys and text, copy and paste. Working the page takes it over —
// the agent pauses until Hand back; looking (moving the pointer, scrolling)
// does not. What is shown and typed never reaches the model.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Hand,
  Layers,
  Lock,
  Minimize2,
  Play,
  RotateCw,
  ClipboardPaste,
  TextSelect,
  X,
} from 'lucide-react';
import type { BrowserHandoffInput, BrowserViewInput } from '@patch/wire';
import { useBrowserHandoffStore, type BrowserForm } from '../stores/browserHandoffStore.js';
import {
  buttonOf,
  driveState,
  fitSize,
  keyForEvent,
  modifiersOf,
  siteOf,
  textInput,
  toViewport,
  viewedTab,
  type DriveState,
} from '../lib/browserHandoff.js';
import {
  sendBrowser,
  sendDrive,
  sendViewInput,
  sendViewMove,
  useBrowserWatch,
  type ViewerViewport,
} from '../lib/browserView.js';
import { closeBrowserLarge, dismissBrowser } from '../lib/browserLayout.js';
import { useUiStore } from '../stores/uiStore.js';
import { getDesktopBridge } from '../lib/desktopBridge.js';
import { ContextMenu, useContextMenu, type ContextMenuItem } from './ContextMenu.js';

/** A press that travels further than this on a touch screen scrolls instead of clicking. */
const TOUCH_SLOP_PX = 8;
/** The agent's cursor fades once it has not moved for this long. */
const CURSOR_FRESH_MS = 4_000;

// ---- Small shared pieces ------------------------------------------------------

/** A site's mark: its first letter on a colour of its own. Nothing is fetched from the site. */
export function SiteTile({ site }: { site: string }): JSX.Element {
  let hash = 0;
  for (const ch of site) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return (
    <span
      className="bv-site-tile"
      style={{ background: `hsl(${hue} 38% 34%)` }}
      aria-hidden
      data-testid="browser-site-tile"
    >
      {(site[0] ?? '·').toUpperCase()}
    </span>
  );
}

const CHIP_LABEL: Record<DriveState, string> = {
  agent: 'Agent driving',
  user: 'You’re driving',
  needs: 'Needs you',
};

export function DriveChip({ state, short }: { state: DriveState; short?: boolean }): JSX.Element {
  const label = short
    ? { agent: 'Agent', user: 'You', needs: 'Needs you' }[state]
    : CHIP_LABEL[state];
  return (
    <span className={`bv-chip is-${state}`} data-testid="browser-drive-chip">
      <i aria-hidden />
      {label}
    </span>
  );
}

/**
 * The one action that changes who has the tab: Take over, Hand back, or Done
 * when the agent asked for the user. `canDrive` is false for a host too old to
 * take a tab over outside a hand-off.
 */
export function DriveAction({
  chatId,
  tabId,
  state,
  handoffId,
  canDrive,
  onTakeOver,
}: {
  chatId: string;
  tabId: string | undefined;
  state: DriveState;
  handoffId: string | undefined;
  canDrive: boolean;
  onTakeOver?: () => void;
}): JSX.Element | null {
  if (state === 'needs' && handoffId) {
    return (
      <button
        type="button"
        className="bv-pill is-dark"
        data-testid="browser-handoff-done"
        onClick={() =>
          sendBrowser({ type: 'patch.browser_handoff.control', chatId, handoffId, action: 'done' })
        }
      >
        <Check size={14} aria-hidden /> Done
      </button>
    );
  }
  if (!tabId || !canDrive) return null;
  if (state === 'user') {
    return (
      <button
        type="button"
        className="bv-pill is-dark"
        data-testid="browser-hand-back"
        onClick={() => sendDrive(chatId, tabId, 'agent')}
      >
        <Play size={13} aria-hidden /> Hand back
      </button>
    );
  }
  return (
    <button
      type="button"
      className="bv-pill"
      data-testid="browser-take-over"
      onClick={() => {
        sendDrive(chatId, tabId, 'user');
        onTakeOver?.();
      }}
    >
      <Hand size={14} aria-hidden /> Take over
    </button>
  );
}

/** The address as a person reads it: no scheme, the site in full weight. */
function AddressField({
  url,
  disabled,
  onGo,
}: {
  url: string;
  disabled: boolean;
  onGo: (text: string) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const site = siteOf(url);
  let path = '';
  try {
    const u = new URL(url);
    path = u.pathname === '/' ? '' : u.pathname;
  } catch {
    path = '';
  }
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const t = text.trim();
    if (t !== '') onGo(t);
    setEditing(false);
  };
  return (
    <form className="bv-address" onSubmit={submit} data-testid="browser-address">
      {site ? <SiteTile site={site} /> : <Lock size={13} aria-hidden />}
      {editing ? (
        <input
          ref={input}
          aria-label="Address"
          data-testid="browser-address-input"
          value={text}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="bv-address-text"
          data-testid="browser-handoff-url"
          disabled={disabled}
          onClick={() => {
            setText(url);
            setEditing(true);
          }}
        >
          <span className="bv-address-site">{site || url}</span>
          {path ? <span className="bv-address-path">{path}</span> : null}
        </button>
      )}
    </form>
  );
}

// ---- The sign-in card ---------------------------------------------------------

/**
 * The page's sign-in form as this surface's own fields, for a screen too small
 * to type into a picture of it. The values go straight into the page's fields
 * and are never shown to the agent.
 */
export function SignInCard({
  chatId,
  form,
  handoffId,
  onUsePage,
}: {
  chatId: string;
  form: BrowserForm;
  handoffId: string;
  onUsePage: () => void;
}): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const filled = form.fields
      .map((f) => ({ field: f.field, value: values[f.field] ?? '' }))
      .filter((v) => v.value !== '');
    if (filled.length === 0) return;
    sendViewInput(chatId, form.tabId, {
      kind: 'fill',
      formId: form.formId,
      values: filled,
      submit: true,
    });
    setValues({});
  };
  return (
    <form className="bv-signin" onSubmit={submit} data-testid="browser-signin">
      <div className="bv-signin-top">
        <SiteTile site={form.site} />
        <div>
          <h3>Sign in to {form.site}</h3>
        </div>
      </div>
      {form.fields.map((f, i) => (
        <input
          key={f.field}
          className="bv-signin-field"
          aria-label={f.label}
          placeholder={f.label}
          type={f.kind === 'password' ? 'password' : f.kind === 'email' ? 'email' : 'text'}
          autoComplete={
            f.kind === 'password'
              ? 'current-password'
              : f.kind === 'code'
                ? 'one-time-code'
                : 'username'
          }
          inputMode={f.kind === 'code' ? 'numeric' : undefined}
          autoFocus={i === 0}
          value={values[f.field] ?? ''}
          onChange={(e) => setValues((v) => ({ ...v, [f.field]: e.target.value }))}
          data-testid={`browser-signin-${f.kind}`}
        />
      ))}
      <button type="submit" className="bv-signin-go" data-testid="browser-signin-submit">
        Sign in
      </button>
      <div className="bv-signin-alt">
        <button type="button" onClick={onUsePage}>
          Use the page instead
        </button>
        <button
          type="button"
          onClick={() =>
            sendBrowser({
              type: 'patch.browser_handoff.control',
              chatId,
              handoffId,
              action: 'cancel',
            })
          }
        >
          Skip
        </button>
      </div>
      <p className="bv-signin-note">
        <Lock size={12} aria-hidden /> The agent can’t see what you type
      </p>
    </form>
  );
}

// ---- The tab itself, in the Patch app ----------------------------------------

/**
 * spec/02 § Browser — In the Patch app: whether this window's app holds the
 * tab, so the large view shows the tab itself rather than a picture of it.
 */
function useAppTab(appTarget: string | undefined): boolean {
  const [owned, setOwned] = useState(false);
  useEffect(() => {
    const bridge = getDesktopBridge()?.agentBrowser;
    if (!bridge || !appTarget) {
      setOwned(false);
      return;
    }
    let live = true;
    bridge.owns(appTarget).then(
      (o) => {
        if (live) setOwned(o);
      },
      (err: unknown) => {
        // The picture still works; say why the tab itself is not shown.
        console.error('browser view: the app could not say whether it holds this tab', err);
        if (live) setOwned(false);
      },
    );
    return () => {
      live = false;
    };
  }, [appTarget]);
  return owned;
}

// ---- The large view -----------------------------------------------------------

interface Ripple {
  id: number;
  x: number;
  y: number;
}

export function BrowserView({
  chatId,
  layout,
}: {
  chatId: string;
  layout: 'pane' | 'screen';
}): JSX.Element {
  const frame = useBrowserHandoffStore((s) => s.frames[chatId]);
  const status = useBrowserHandoffStore((s) => s.status[chatId]);
  const handoff = useBrowserHandoffStore((s) => s.handoffs[chatId]);
  const form = useBrowserHandoffStore((s) => s.forms[chatId]);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [usePage, setUsePage] = useState(false);
  const tabId =
    handoff?.tabId ??
    (picked && status?.tabs.some((t) => t.tabId === picked)
      ? picked
      : viewedTab(undefined, frame, status));
  const shown = frame && frame.tabId === tabId ? frame : undefined;
  const v2 = (frame?.inputVersion ?? 0) >= 2;
  const state = driveState(handoff, status, tabId);
  const tabInfo = status?.tabs.find((t) => t.tabId === tabId);
  const appTarget = tabInfo?.appTarget;
  // The tab itself is laid over the stage: it takes the user's input directly.
  const native = useAppTab(appTarget);
  const canInput = !native && Boolean(tabId) && (v2 || Boolean(handoff));

  const stageRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = (): void => setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The page takes this view's size, told once the stage stops changing.
  const [viewport, setViewport] = useState<ViewerViewport | null>(null);
  useEffect(() => {
    if (stage.width < 1 || stage.height < 1) return;
    const next = {
      width: Math.floor(stage.width),
      height: Math.floor(stage.height),
      scale: Math.min(3, Math.max(1, Math.round((window.devicePixelRatio || 1) * 100) / 100)),
    };
    const t = setTimeout(() => setViewport(next), 200);
    return () => clearTimeout(t);
  }, [stage.width, stage.height]);
  // A tab shown as itself sizes to its own view; the host only needs its address and state.
  useBrowserWatch(chatId, true, tabId, native ? null : viewport);

  // Typing goes to the page from the moment the view opens on a tab the user may use.
  useEffect(() => {
    if (canInput) keysRef.current?.focus({ preventScroll: true });
  }, [canInput]);

  // An older host takes input only during a hand-off, in its own shapes.
  const legacy = (input: BrowserHandoffInput): void => {
    if (!handoff) return;
    sendBrowser({
      type: 'patch.browser_handoff.input',
      chatId,
      handoffId: handoff.handoffId,
      input,
    });
  };
  const send = (input: BrowserViewInput): void => {
    if (!tabId) return;
    if (v2) {
      sendViewInput(chatId, tabId, input);
      return;
    }
    if (input.kind === 'text' || input.kind === 'scroll') legacy(input);
    else if (input.kind === 'key' && (input.action ?? 'press') === 'press') {
      legacy({ kind: 'key', key: input.key });
    }
  };

  // Moves and wheel turns come far faster than a page repaints: at most one of each per frame.
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const pendingWheel = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const raf = useRef<number | null>(null);
  /** Where the page's pointer is now, as last sent. */
  const lastAt = useRef<{ x: number; y: number } | null>(null);
  const live = useRef({ chatId, tabId, v2, send, legacy });
  live.current = { chatId, tabId, v2, send, legacy };
  const flush = useCallback((): void => {
    raf.current = null;
    const { chatId: c, tabId: t, v2: modern, send: s, legacy: old } = live.current;
    const m = pendingMove.current;
    pendingMove.current = null;
    if (m && t) {
      lastAt.current = m;
      if (modern) sendViewMove(c, t, { kind: 'pointer', action: 'move', ...m });
      else old({ kind: 'pointer', action: 'move', ...m });
    }
    const w = pendingWheel.current;
    pendingWheel.current = null;
    if (w) s({ kind: 'scroll', x: w.x, y: w.y, dx: Math.round(w.dx), dy: Math.round(w.dy) });
  }, []);
  const schedule = useCallback((): void => {
    if (raf.current === null) raf.current = requestAnimationFrame(flush);
  }, [flush]);
  const flushNow = (): void => {
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      flush();
    }
  };
  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const fit = shown ? fitSize(stage, shown) : { width: 0, height: 0 };
  const at = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const el = surfaceRef.current;
    if (!el || !shown) return null;
    return toViewport(e, el.getBoundingClientRect(), shown);
  };

  // The wheel must be a non-passive listener so the chat behind does not scroll instead.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el || !canInput) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const p = at(e);
      if (!p) return;
      const w = pendingWheel.current;
      pendingWheel.current = w
        ? { ...p, dx: w.dx + e.deltaX, dy: w.dy + e.deltaY }
        : { ...p, dx: e.deltaX, dy: e.deltaY };
      schedule();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const [ripples, setRipples] = useState<Ripple[]>([]);
  const rippleId = useRef(0);
  const ripple = (e: { clientX: number; clientY: number }): void => {
    const el = surfaceRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const id = ++rippleId.current;
    setRipples((rs) => [...rs, { id, x: e.clientX - r.left, y: e.clientY - r.top }]);
    setTimeout(() => setRipples((rs) => rs.filter((x) => x.id !== id)), 450);
  };

  /** A finger on a touch screen: a tap clicks, a drag scrolls (never both). */
  const touch = useRef<{
    id: number;
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null>(null);
  const pressed = useRef(false);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!canInput) return;
    keysRef.current?.focus({ preventScroll: true });
    if (e.pointerType === 'touch') {
      touch.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
      };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      return;
    }
    if (e.button === 2) return; // the context menu answers a right press
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    flushNow();
    const p = at(e);
    if (!p) return;
    ripple(e);
    pressed.current = true;
    lastAt.current = p;
    if (v2) {
      const mods = modifiersOf(e);
      sendViewInput(chatId, tabId!, {
        kind: 'pointer',
        action: 'down',
        ...p,
        button: buttonOf(e.button),
        clickCount: Math.min(3, Math.max(1, e.detail || 1)),
        ...(mods.length > 0 ? { modifiers: mods } : {}),
      });
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!canInput) return;
    const t = touch.current;
    if (t && t.id === e.pointerId) {
      if (!t.moved && Math.hypot(e.clientX - t.x, e.clientY - t.y) < TOUCH_SLOP_PX) return;
      t.moved = true;
      const p = at(e);
      if (!p || !shown || fit.width === 0) return;
      const k = shown.width / fit.width;
      const w = pendingWheel.current;
      const dx = (t.lastX - e.clientX) * k;
      const dy = (t.lastY - e.clientY) * k;
      pendingWheel.current = w ? { ...p, dx: w.dx + dx, dy: w.dy + dy } : { ...p, dx, dy };
      t.lastX = e.clientX;
      t.lastY = e.clientY;
      schedule();
      return;
    }
    if (e.pointerType === 'touch') return;
    const p = at(e);
    if (!p) return;
    pendingMove.current = p;
    schedule();
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!canInput) return;
    const t = touch.current;
    if (t && t.id === e.pointerId) {
      touch.current = null;
      if (t.moved) return;
      const p = at(e);
      if (!p) return;
      ripple(e);
      if (v2) send({ kind: 'pointer', action: 'click', ...p });
      else legacy({ kind: 'pointer', action: 'click', ...p });
      return;
    }
    if (e.button === 2 || !pressed.current) return;
    pressed.current = false;
    // The release must not overtake the move that led to it.
    const p = at(e);
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    if (p && (p.x !== lastAt.current?.x || p.y !== lastAt.current?.y)) pendingMove.current = p;
    flush();
    if (!p) return;
    if (v2) {
      const mods = modifiersOf(e);
      sendViewInput(chatId, tabId!, {
        kind: 'pointer',
        action: 'up',
        ...p,
        button: buttonOf(e.button),
        clickCount: Math.min(3, Math.max(1, e.detail || 1)),
        ...(mods.length > 0 ? { modifiers: mods } : {}),
      });
    } else {
      legacy({ kind: 'pointer', action: 'click', ...p });
    }
  };

  const menu = useContextMenu();
  const paste = (): void => {
    navigator.clipboard.readText().then(
      (text) => {
        const t = textInput(text);
        if (t) send(t);
      },
      (err: unknown) => {
        useUiStore
          .getState()
          .pushError(
            'Couldn’t paste into the browser',
            undefined,
            err instanceof Error ? err.message : String(err),
          );
      },
    );
  };
  const nav = (action: 'back' | 'forward' | 'reload' | 'goto', url?: string): void => {
    if (!tabId || !v2) return;
    sendViewInput(chatId, tabId, { kind: 'nav', action, ...(url ? { url } : {}) });
  };
  const pageMenu: ContextMenuItem[] = [
    { id: 'back', label: 'Back', icon: <ChevronLeft size={14} />, run: () => nav('back') },
    {
      id: 'forward',
      label: 'Forward',
      icon: <ChevronRight size={14} />,
      run: () => nav('forward'),
    },
    { id: 'reload', label: 'Reload', icon: <RotateCw size={14} />, run: () => nav('reload') },
    { id: 'copy', label: 'Copy', icon: <Copy size={14} />, run: () => send({ kind: 'copy' }) },
    { id: 'paste', label: 'Paste', icon: <ClipboardPaste size={14} />, run: paste },
    {
      id: 'select-all',
      label: 'Select all',
      icon: <TextSelect size={14} />,
      run: () => send({ kind: 'key', key: 'Meta+a' }),
    },
  ];

  const tabsMenu = useContextMenu();
  const tabItems: ContextMenuItem[] = [
    ...(status?.tabs ?? []).map((t, i) => ({
      id: t.tabId,
      label: `${t.tabId === tabId ? '✓ ' : ''}${siteOf(t.url) || `Tab ${i + 1}`}`,
      icon: <SiteTile site={siteOf(t.url)} />,
      run: () => setPicked(t.tabId),
    })),
    {
      id: 'stop',
      label: 'Stop browsing',
      icon: <X size={14} />,
      danger: true,
      run: () => sendBrowser({ type: 'patch.browser_view.stop', chatId }),
    },
  ];

  // Lay the tab itself over the stage, following it as panes move and resize.
  // A menu of ours would open underneath it, so it steps aside while one is open.
  const menuOpen = tabsMenu.anchor !== null;
  useEffect(() => {
    const bridge = getDesktopBridge()?.agentBrowser;
    const el = stageRef.current;
    if (!native || !bridge || !appTarget || !el) return;
    if (menuOpen) {
      bridge.hide(appTarget);
      return;
    }
    let last = '';
    const place = (): void => {
      const r = el.getBoundingClientRect();
      const key = `${r.x},${r.y},${r.width},${r.height}`;
      if (key === last || r.width < 1 || r.height < 1) return;
      last = key;
      bridge.show(appTarget, { x: r.x, y: r.y, width: r.width, height: r.height });
    };
    place();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    ro?.observe(el);
    const poll = setInterval(place, 250);
    window.addEventListener('resize', place);
    return () => {
      ro?.disconnect();
      clearInterval(poll);
      window.removeEventListener('resize', place);
      bridge.hide(appTarget);
    };
  }, [native, appTarget, menuOpen]);

  // The user working the tab itself takes it over — but not the agent's own
  // clicks, which the app sees the same way: only while the agent is not acting.
  useEffect(() => {
    const bridge = getDesktopBridge()?.agentBrowser;
    if (!native || !bridge || !appTarget || !tabId) return;
    return bridge.onInput((e) => {
      if (e.targetId !== appTarget) return;
      const s = useBrowserHandoffStore.getState();
      const st = s.status[chatId];
      if (driveState(s.handoffs[chatId], st, tabId) !== 'agent' || st?.active) return;
      sendDrive(chatId, tabId, 'user');
    });
  }, [native, appTarget, chatId, tabId]);

  const cursor = tabInfo?.cursor;
  const showCursor =
    !native &&
    state === 'agent' &&
    cursor !== undefined &&
    shown !== undefined &&
    Date.now() - cursor.at < CURSOR_FRESH_MS;
  const k = shown && fit.width > 0 ? fit.width / shown.width : 1;
  const showSignIn =
    layout === 'screen' &&
    state === 'needs' &&
    form !== undefined &&
    handoff !== undefined &&
    !usePage;

  const close = (): void => dismissBrowser(chatId);
  const shrink = (): void => closeBrowserLarge(chatId, 'mini');

  return (
    <section
      className={`bv bv-${layout} is-${state}`}
      aria-label="Agent browser"
      data-testid="browser-live"
    >
      <header className="bv-toolbar">
        {layout === 'screen' ? (
          <button
            type="button"
            className="bv-icon"
            aria-label="Back to the chat"
            data-testid="browser-live-minimise"
            onClick={close}
          >
            <ChevronDown size={18} aria-hidden />
          </button>
        ) : (
          <div className="bv-nav">
            <button
              type="button"
              className="bv-icon"
              aria-label="Back"
              data-testid="browser-back"
              disabled={!v2 || !shown?.canGoBack}
              onClick={() => nav('back')}
            >
              <ChevronLeft size={17} aria-hidden />
            </button>
            <button
              type="button"
              className="bv-icon"
              aria-label="Forward"
              data-testid="browser-forward"
              disabled={!v2 || !shown?.canGoForward}
              onClick={() => nav('forward')}
            >
              <ChevronRight size={17} aria-hidden />
            </button>
            <button
              type="button"
              className="bv-icon"
              aria-label="Reload"
              data-testid="browser-reload"
              disabled={!v2}
              onClick={() => nav('reload')}
            >
              <RotateCw size={15} aria-hidden />
            </button>
          </div>
        )}
        <AddressField
          url={shown?.url ?? tabInfo?.url ?? ''}
          disabled={!v2}
          onGo={(t) => nav('goto', t)}
        />
        <DriveChip
          state={state}
          short={layout === 'screen' || (stage.width > 0 && stage.width < 640)}
        />
        {layout === 'pane' ? (
          <DriveAction
            chatId={chatId}
            tabId={tabId}
            state={state}
            handoffId={handoff?.handoffId}
            canDrive={v2}
          />
        ) : null}
        <button
          type="button"
          className="bv-icon"
          aria-label="Tabs"
          data-testid="browser-tabs"
          onClick={(e) => tabsMenu.openAt(e)}
        >
          {layout === 'pane' ? (
            <Layers size={15} aria-hidden />
          ) : (
            <span className="bv-more" aria-hidden>
              ···
            </span>
          )}
        </button>
        {layout === 'pane' ? (
          <>
            <button
              type="button"
              className="bv-icon"
              aria-label="Shrink to preview"
              data-testid="browser-shrink"
              onClick={shrink}
            >
              <Minimize2 size={15} aria-hidden />
            </button>
            <button
              type="button"
              className="bv-icon"
              aria-label="Close browser view"
              data-testid="browser-live-close"
              onClick={close}
            >
              <X size={16} aria-hidden />
            </button>
          </>
        ) : null}
      </header>
      <div
        className={`bv-stage${native ? ' is-native' : ''}`}
        ref={stageRef}
        data-testid="browser-stage"
      >
        {native ? null : shown ? (
          <div
            className="bv-picture"
            style={fit.width > 0 ? { width: fit.width, height: fit.height } : undefined}
          >
            <img
              className="bv-frame"
              data-testid="browser-handoff-frame"
              alt={shown.title || 'Browser tab'}
              src={`data:image/jpeg;base64,${shown.data}`}
              decoding="async"
              draggable={false}
            />
            <div
              ref={surfaceRef}
              className={`bv-surface${canInput ? ' is-live' : ''}`}
              data-testid="browser-surface"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => {
                touch.current = null;
                pressed.current = false;
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (canInput && v2) menu.openAt(e);
              }}
            />
            {showCursor ? (
              <span
                className="bv-agent-cursor"
                style={{ left: cursor.x * k, top: cursor.y * k }}
                data-testid="browser-agent-cursor"
                aria-hidden
              >
                <svg viewBox="0 0 24 24">
                  <path d="M4 3l7.5 17 2.6-7.4L21.5 10z" />
                </svg>
                <span>Agent</span>
              </span>
            ) : null}
            {ripples.map((r) => (
              <span key={r.id} className="bv-ripple" style={{ left: r.x, top: r.y }} aria-hidden />
            ))}
          </div>
        ) : (
          <p className="bv-empty" data-testid="browser-handoff-empty">
            {tabId ? 'Connecting' : 'No browser tab is open for this chat'}
          </p>
        )}
        {canInput ? (
          <input
            ref={keysRef}
            className="bv-keys"
            data-testid="browser-handoff-keys"
            aria-label="Keyboard"
            type="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onInput={(e) => {
              const t = textInput(e.currentTarget.value);
              e.currentTarget.value = '';
              if (t) send(t);
            }}
            onPaste={(e) => {
              e.preventDefault();
              const t = textInput(e.clipboardData.getData('text/plain'));
              if (t) send(t);
            }}
            onKeyDown={(e) => {
              const cmd = (e.metaKey || e.ctrlKey) && !e.altKey;
              const letter = e.key.toLowerCase();
              if (cmd && letter === 'c' && v2) {
                e.preventDefault();
                send({ kind: 'copy' });
                return;
              }
              if (cmd && letter === 'x' && v2) {
                e.preventDefault();
                send({ kind: 'copy' });
                send({ kind: 'key', key: e.metaKey ? 'Meta+x' : 'Control+x' });
                return;
              }
              const key = keyForEvent(e);
              if (key === null) return;
              e.preventDefault();
              send({ kind: 'key', key });
            }}
          />
        ) : null}
        {showSignIn ? (
          <div className="bv-signin-wrap">
            <SignInCard
              chatId={chatId}
              form={form}
              handoffId={handoff.handoffId}
              onUsePage={() => setUsePage(true)}
            />
          </div>
        ) : null}
      </div>
      {layout === 'screen' ? (
        <footer className="bv-foot">
          <DriveAction
            chatId={chatId}
            tabId={tabId}
            state={state}
            handoffId={handoff?.handoffId}
            canDrive={v2}
          />
          {state === 'needs' && handoff ? (
            <span className="bv-foot-reason" data-testid="browser-handoff-title">
              {handoff.reason}
            </span>
          ) : null}
        </footer>
      ) : null}
      <ContextMenu
        anchor={menu.anchor}
        items={pageMenu}
        onClose={menu.close}
        label="Page"
        testId="browser-page-menu"
      />
      <ContextMenu
        anchor={tabsMenu.anchor}
        items={tabItems}
        onClose={tabsMenu.close}
        label="Tabs"
        testId="browser-tabs-menu"
      />
    </section>
  );
}
