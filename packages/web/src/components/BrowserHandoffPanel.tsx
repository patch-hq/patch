// BrowserHandoffPanel — the agent's browser tab, live in the chat
// (spec/14 § Browser hand-off). Three shapes over one stream of frames:
//   - a bar: "Browsing <site>" with Watch and Stop;
//   - a small floating preview the user can drag anywhere in the window;
//   - the expanded view, a large live tab. During a hand-off (the agent asked
//     the user to sign in, pass 2FA, approve a consent) pointer moves, clicks,
//     scrolls and keys here go straight to the tab, and the agent is locked
//     out until Done.
// What is shown and typed travels only between the host and this surface; it
// is never a tool result, so the model does not see it.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, Eye, Maximize2, Minimize2, Square, X } from 'lucide-react';
import type { BrowserHandoffInput } from '@patch/wire';
import { getActiveWs } from '../api/ws.js';
import {
  useBrowserHandoffStore,
  type BrowserFrame,
  type BrowserHandoff,
} from '../stores/browserHandoffStore.js';
import { useChatStore } from '../stores/chatStore.js';
import {
  browsingLabel,
  canStopBrowser,
  chatUsedBrowser,
  clampPreview,
  fitSize,
  keyForEvent,
  loadPreviewPosition,
  savePreviewPosition,
  textInput,
  toViewport,
  type PreviewPosition,
} from '../lib/browserHandoff.js';

const WATCH_RENEW_MS = 5_000;
const NO_FRAME_MS = 4_000;
/** A press that moves further than this is a drag of the preview, not a tap on it. */
const DRAG_SLOP_PX = 4;
const PREVIEW_MARGIN_PX = 12;

export function BrowserHandoffPanel({ chatId }: { chatId: string }): JSX.Element | null {
  const handoff = useBrowserHandoffStore((s) => s.handoffs[chatId]);
  const frame = useBrowserHandoffStore((s) => s.frames[chatId]);
  const status = useBrowserHandoffStore((s) => s.status[chatId]);
  const timeline = useChatStore((s) => s.timelines[chatId]);
  const [watching, setWatching] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [noFrame, setNoFrame] = useState(false);

  // Ask the host for the chat's open tab's frames, and keep asking while we look.
  useEffect(() => {
    if (!watching) return;
    const ask = (): void =>
      getActiveWs()?.safeSend({ type: 'patch.browser_view.watch', chatId, watch: true });
    ask();
    const renew = setInterval(ask, WATCH_RENEW_MS);
    const none = setTimeout(() => setNoFrame(true), NO_FRAME_MS);
    return () => {
      clearInterval(renew);
      clearTimeout(none);
      getActiveWs()?.safeSend({ type: 'patch.browser_view.watch', chatId, watch: false });
    };
  }, [watching, chatId]);

  // A frame arrived: the "no tab" notice no longer applies.
  useEffect(() => {
    if (frame) setNoFrame(false);
  }, [frame]);

  // Nothing left to show: fold the expanded view away with it.
  const showing = Boolean(handoff) || watching;
  useEffect(() => {
    if (!showing) setExpanded(false);
  }, [showing]);

  // The user's Stop: ends this chat's browsing (its calls fail with browser_stopped, its tabs close).
  const stop = (): void => getActiveWs()?.send({ type: 'patch.browser_view.stop', chatId });
  const stoppable = canStopBrowser(status);

  if (!showing) {
    if (!chatUsedBrowser(timeline ?? []) && !stoppable) return null;
    return (
      <div className="browser-handoff-bar" data-testid="browser-watch-bar">
        <span className="browser-handoff-status" data-testid="browser-status">
          {browsingLabel(status)}
        </span>
        <button
          type="button"
          className="artifact-bar-chip"
          data-testid="browser-watch"
          onClick={() => {
            setNoFrame(false);
            setWatching(true);
          }}
        >
          <Eye size={14} aria-hidden />
          <span className="artifact-bar-title">Watch</span>
        </button>
        {stoppable ? (
          <button
            type="button"
            className="artifact-bar-chip"
            data-testid="browser-stop"
            aria-label="Stop browsing"
            onClick={stop}
          >
            <Square size={14} aria-hidden />
            <span className="artifact-bar-title">Stop</span>
          </button>
        ) : null}
      </div>
    );
  }

  const send = (input: BrowserHandoffInput | null): void => {
    if (!input || !handoff) return;
    getActiveWs()?.send({
      type: 'patch.browser_handoff.input',
      chatId,
      handoffId: handoff.handoffId,
      input,
    });
  };
  const control = (action: 'done' | 'cancel'): void => {
    if (!handoff) return;
    getActiveWs()?.send({
      type: 'patch.browser_handoff.control',
      chatId,
      handoffId: handoff.handoffId,
      action,
    });
  };
  const closeWatch = (): void => {
    setWatching(false);
    useBrowserHandoffStore.getState().clearFrame(chatId);
  };
  const title = handoff ? handoff.reason : browsingLabel(status);
  const empty = noFrame ? 'No browser tab is open for this chat' : 'Connecting';

  // Portalled to the body: a transformed ancestor in the chat pane would otherwise
  // become the containing block of these fixed-position layers.
  if (expanded) {
    return createPortal(
      <LiveView
        title={title}
        frame={frame}
        handoff={handoff}
        empty={empty}
        send={send}
        onDone={() => control('done')}
        onCancel={() => control('cancel')}
        onMinimise={() => setExpanded(false)}
        onStop={stoppable && !handoff ? stop : undefined}
      />,
      document.body,
    );
  }
  return createPortal(
    <FloatingPreview
      title={title}
      frame={frame}
      handoff={handoff}
      empty={empty}
      onExpand={() => setExpanded(true)}
      onDone={() => control('done')}
      onStop={stoppable && !handoff ? stop : undefined}
      onClose={handoff ? undefined : closeWatch}
    />,
    document.body,
  );
}

// ---- The picture ------------------------------------------------------------

/**
 * The newest frame. The browser keeps the previous picture on screen until the
 * new one has decoded, so swapping the source does not flicker.
 */
function FrameImage({
  frame,
  className,
  testId,
  style,
  imgRef,
  ...handlers
}: {
  frame: BrowserFrame;
  className: string;
  testId: string;
  style?: React.CSSProperties;
  imgRef?: React.RefObject<HTMLImageElement | null>;
} & React.ImgHTMLAttributes<HTMLImageElement>): JSX.Element {
  return (
    <img
      ref={imgRef}
      className={className}
      data-testid={testId}
      alt={frame.title || 'Browser tab'}
      src={`data:image/jpeg;base64,${frame.data}`}
      decoding="async"
      draggable={false}
      style={style}
      {...handlers}
    />
  );
}

// ---- Floating preview -------------------------------------------------------

function FloatingPreview({
  title,
  frame,
  handoff,
  empty,
  onExpand,
  onDone,
  onStop,
  onClose,
}: {
  title: string;
  frame: BrowserFrame | undefined;
  handoff: BrowserHandoff | undefined;
  empty: string;
  onExpand: () => void;
  onDone: () => void;
  onStop: (() => void) | undefined;
  onClose: (() => void) | undefined;
}): JSX.Element {
  const cardRef = useRef<HTMLElement>(null);
  const [pos, setPos] = useState<PreviewPosition | null>(null);
  const drag = useRef<{
    id: number;
    startX: number;
    startY: number;
    from: PreviewPosition;
    moved: boolean;
  } | null>(null);

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
      x: w.width - s.width - PREVIEW_MARGIN_PX,
      y: w.height - s.height - 120,
    };
    setPos(clampPreview(start, s, w, PREVIEW_MARGIN_PX));
  }, []);

  // Stay on screen as the window or the picture changes size.
  useEffect(() => {
    const keep = (): void =>
      setPos((p) => (p ? clampPreview(p, size(), win(), PREVIEW_MARGIN_PX) : p));
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
    } else {
      onExpand();
    }
  };

  return (
    <section
      ref={cardRef}
      className={`browser-preview${handoff ? ' is-handoff' : ''}${pos ? '' : ' is-placing'}`}
      data-testid="browser-handoff"
      aria-label="Agent browser"
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (drag.current = null)}
    >
      <header className="browser-preview-head">
        <span className="browser-preview-title" data-testid="browser-handoff-title" title={title}>
          {title}
        </span>
        <div className="browser-preview-actions">
          <button
            type="button"
            aria-label="Expand browser"
            data-testid="browser-handoff-expand"
            onClick={onExpand}
          >
            <Maximize2 size={14} aria-hidden />
          </button>
          {onStop ? (
            <button
              type="button"
              aria-label="Stop browsing"
              data-testid="browser-stop"
              onClick={onStop}
            >
              <Square size={14} aria-hidden />
            </button>
          ) : null}
          {onClose ? (
            <button
              type="button"
              aria-label="Close browser view"
              data-testid="browser-watch-close"
              onClick={onClose}
            >
              <X size={14} aria-hidden />
            </button>
          ) : null}
        </div>
      </header>
      <div className="browser-preview-picture">
        {frame ? (
          <FrameImage
            frame={frame}
            className="browser-preview-frame"
            testId="browser-handoff-preview"
            style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
          />
        ) : (
          <p className="browser-handoff-empty" data-testid="browser-handoff-empty">
            {empty}
          </p>
        )}
        {handoff ? <span className="browser-preview-cue">Tap to take over</span> : null}
      </div>
      {handoff ? (
        <footer className="browser-preview-foot">
          <button
            type="button"
            className="browser-handoff-done"
            data-testid="browser-handoff-done"
            onClick={onDone}
          >
            <Check size={14} aria-hidden /> Done
          </button>
        </footer>
      ) : null}
    </section>
  );
}

// ---- Expanded live view -----------------------------------------------------

interface Ripple {
  id: number;
  x: number;
  y: number;
}

function LiveView({
  title,
  frame,
  handoff,
  empty,
  send,
  onDone,
  onCancel,
  onMinimise,
  onStop,
}: {
  title: string;
  frame: BrowserFrame | undefined;
  handoff: BrowserHandoff | undefined;
  empty: string;
  send: (input: BrowserHandoffInput | null) => void;
  onDone: () => void;
  onCancel: () => void;
  onMinimise: () => void;
  onStop: (() => void) | undefined;
}): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const keysRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const rippleId = useRef(0);
  const live = Boolean(handoff);

  // Fit the picture to the stage, keeping the page's shape, so a point on it maps straight to a page pixel.
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

  // Typing goes to the tab from the moment the view opens.
  useEffect(() => {
    if (live) keysRef.current?.focus();
  }, [live]);

  // Moves and wheel turns arrive far faster than a page repaints: send at most one of each per frame.
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const pendingWheel = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const raf = useRef<number | null>(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  const flush = useCallback((): void => {
    raf.current = null;
    const m = pendingMove.current;
    pendingMove.current = null;
    if (m) sendRef.current({ kind: 'pointer', action: 'move', ...m });
    const w = pendingWheel.current;
    pendingWheel.current = null;
    if (w)
      sendRef.current({
        kind: 'scroll',
        x: w.x,
        y: w.y,
        dx: Math.round(w.dx),
        dy: Math.round(w.dy),
      });
  }, []);
  const schedule = useCallback((): void => {
    if (raf.current === null) raf.current = requestAnimationFrame(flush);
  }, [flush]);
  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const at = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const img = imgRef.current;
    if (!img || !frame) return null;
    return toViewport(e, img.getBoundingClientRect(), frame);
  };

  // The wheel must be a non-passive listener so the chat behind does not scroll instead.
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !live) return;
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
    img.addEventListener('wheel', onWheel, { passive: false });
    return () => img.removeEventListener('wheel', onWheel);
  });

  const pressAt = (e: React.MouseEvent<HTMLImageElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    const id = ++rippleId.current;
    setRipples((rs) => [...rs, { id, x: e.clientX - r.left, y: e.clientY - r.top }]);
    setTimeout(() => setRipples((rs) => rs.filter((x) => x.id !== id)), 450);
  };

  const fit = frame ? fitSize(stage, frame) : { width: 0, height: 0 };
  const sized = fit.width > 0 && fit.height > 0;

  return (
    <div className="browser-live-backdrop" data-testid="browser-live">
      <section
        className={`browser-live${live ? ' is-handoff' : ''}`}
        aria-label="Agent browser"
        aria-modal="true"
        role="dialog"
      >
        <header className="browser-live-head">
          <button
            type="button"
            aria-label="Shrink to preview"
            data-testid="browser-live-minimise"
            onClick={onMinimise}
          >
            <Minimize2 size={16} aria-hidden />
          </button>
          <div className="browser-live-heading">
            <h3 className="browser-live-title" data-testid="browser-handoff-title">
              {title}
            </h3>
            <div className="browser-handoff-url" data-testid="browser-handoff-url">
              {frame?.url ?? ''}
            </div>
          </div>
          {live ? (
            <div className="browser-live-actions">
              <button type="button" data-testid="browser-handoff-cancel" onClick={onCancel}>
                <X size={16} aria-hidden /> Cancel
              </button>
              <button
                type="button"
                className="browser-handoff-done"
                data-testid="browser-handoff-done"
                onClick={onDone}
              >
                <Check size={16} aria-hidden /> Done
              </button>
            </div>
          ) : (
            <div className="browser-live-actions">
              <span className="browser-live-viewonly">View only</span>
              {onStop ? (
                <button type="button" data-testid="browser-stop" onClick={onStop}>
                  <Square size={16} aria-hidden /> Stop
                </button>
              ) : null}
            </div>
          )}
        </header>
        <div className="browser-live-stage" ref={stageRef}>
          {frame ? (
            <div
              className="browser-live-picture"
              style={sized ? { width: fit.width, height: fit.height } : undefined}
            >
              <FrameImage
                frame={frame}
                imgRef={imgRef}
                className="browser-live-frame"
                testId="browser-handoff-frame"
                onPointerMove={(e) => {
                  if (!live || e.pointerType === 'touch') return;
                  const p = at(e);
                  if (!p) return;
                  pendingMove.current = p;
                  schedule();
                }}
                onClick={(e) => {
                  if (!live) return;
                  keysRef.current?.focus();
                  const p = at(e);
                  if (!p) return;
                  pressAt(e);
                  // A click must not overtake the move that led to it.
                  if (raf.current !== null) {
                    cancelAnimationFrame(raf.current);
                    flush();
                  }
                  send({ kind: 'pointer', action: 'click', ...p });
                }}
                onDoubleClick={(e) => {
                  if (!live) return;
                  const p = at(e);
                  if (p) send({ kind: 'pointer', action: 'double_click', ...p });
                }}
                onContextMenu={(e) => {
                  if (!live) return;
                  e.preventDefault();
                  const p = at(e);
                  if (p) send({ kind: 'pointer', action: 'right_click', ...p });
                }}
              />
              {ripples.map((r) => (
                <span
                  key={r.id}
                  className="browser-live-ripple"
                  style={{ left: r.x, top: r.y }}
                  aria-hidden
                />
              ))}
            </div>
          ) : (
            <p className="browser-handoff-empty" data-testid="browser-handoff-empty">
              {empty}
            </p>
          )}
          {live ? (
            <input
              ref={keysRef}
              className="browser-handoff-keys"
              data-testid="browser-handoff-keys"
              aria-label="Keyboard"
              type="text"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              onInput={(e) => {
                send(textInput(e.currentTarget.value));
                e.currentTarget.value = '';
              }}
              onPaste={(e) => {
                e.preventDefault();
                send(textInput(e.clipboardData.getData('text/plain')));
              }}
              onKeyDown={(e) => {
                const key = keyForEvent(e);
                if (key === null) return;
                e.preventDefault();
                send({ kind: 'key', key });
              }}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}
