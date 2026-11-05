// windowChrome — does THIS window have the desktop shell's overlay title bar?
//
// spec/05 § Desktop packaging (Electron) → Window chrome: the Electron shell
// draws its document windows (main + spec/14 § New windows children) with no
// native title bar, so the SPA reaches the window's top edge and the macOS
// traffic lights float over its top-left. Two consequences the renderer owns:
// keep that top-left strip clear, and provide a drag region, because there is
// no title bar left to move the window by.
//
// The answer needs two facts held on different sides of the bridge:
//   - the PLATFORM hid the bar — only the shell knows, so `preload.ts` hands it
//     over as `patch.overlayTitleBar` (a plain value, readable on first paint);
//   - this window is a document window, not one of the two frameless popovers.
//     The preload cannot tell which window it was injected into; the route can.
//
// NO FALLBACK: a plain browser has no bridge and gets no inset at all, rather
// than a guess based on user-agent sniffing.

import { useEffect } from 'react';
import { getDesktopBridge } from './desktopBridge.js';

/** Set on <html> when this window's content runs under the traffic lights. */
export const OVERLAY_TITLE_BAR_CLASS = 'overlay-titlebar';

/**
 * Set alongside it when the shell can move the lights. A banner at the top is
 * then the title bar: the lights sit centred inside it at its natural height,
 * instead of the banner being stretched down to reach lights pinned for the
 * sidebar row (which left them hugging its bottom edge, off the text's line).
 */
export const SEATABLE_LIGHTS_CLASS = 'lights-seatable';

/**
 * Routes the shell only ever loads into a `frame: false` popover — the tray
 * popover (`/menubar`) and the voice overlay (`/voice-overlay`). Those windows
 * have NO traffic lights and no title bar to begin with, so reserving a strip
 * for lights that aren't there would just indent them. `/sidebar-window` is
 * deliberately absent: it is a real child window and does have them.
 */
const FRAMELESS_POPOVER_ROUTES = ['/menubar', '/voice-overlay'];

/**
 * `pathname` is the raw `window.location.pathname`, so it carries the SPA's
 * `/app` base path in production and none in the dev harness. Matched on the
 * tail so both forms resolve the same way.
 */
export function hasOverlayTitleBar(o: { overlayTitleBar: boolean; pathname: string }): boolean {
  if (!o.overlayTitleBar) return false;
  return !FRAMELESS_POPOVER_ROUTES.some((r) => o.pathname === r || o.pathname.endsWith(r));
}

/** Apply (or remove) the marker class the stylesheet keys its insets off. */
export function applyOverlayTitleBarClass(
  root: { classList: { toggle(token: string, force: boolean): void } },
  o: { overlayTitleBar: boolean; pathname: string },
): void {
  root.classList.toggle(OVERLAY_TITLE_BAR_CLASS, hasOverlayTitleBar(o));
}

/**
 * Boot hook for the real entry points. Called synchronously before the first
 * render so the inset is part of the first paint rather than a visible jump
 * one frame in — which is why this is not a `useEffect` in AppShell.
 */
export function initWindowChrome(): void {
  const bridge = getDesktopBridge();
  const o = {
    overlayTitleBar: bridge?.overlayTitleBar === true,
    pathname: window.location.pathname,
  };
  applyOverlayTitleBarClass(document.documentElement, o);
  document.documentElement.classList.toggle(
    SEATABLE_LIGHTS_CLASS,
    hasOverlayTitleBar(o) && typeof bridge?.seatTrafficLights === 'function',
  );
}

/**
 * The lights' centre for a shell whose first child is `top`: the middle of a
 * banner, or null (the brand row) when the first thing is the app itself.
 */
export function lightsCentreFor(top: Element | null): number | null {
  if (top === null || top.classList.contains('three-col')) return null;
  const r = top.getBoundingClientRect();
  return r.height > 0 ? Math.round(r.top + r.height / 2) : null;
}

/**
 * Keep the traffic lights on whatever strip is the window's top row. Watches
 * the shell's children (banners come and go) and that strip's size, and tells
 * the shell only when the answer changes.
 */
export function useSeatTrafficLights(el: HTMLElement | null): void {
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (el === null || !document.documentElement.classList.contains(SEATABLE_LIGHTS_CLASS)) return;
    const seat = bridge?.seatTrafficLights;
    if (typeof seat !== 'function') return;
    let sent: number | null | undefined;
    let watched: Element | null = null;
    const update = (): void => {
      const top = el.firstElementChild;
      if (top !== watched) {
        if (watched !== null) sizes.unobserve(watched);
        watched = top;
        if (top !== null) sizes.observe(top);
      }
      const centre = lightsCentreFor(top);
      if (centre === sent) return;
      sent = centre;
      seat.call(bridge, centre);
    };
    const sizes = new ResizeObserver(update);
    const children = new MutationObserver(update);
    children.observe(el, { childList: true });
    update();
    return () => {
      children.disconnect();
      sizes.disconnect();
      seat.call(bridge, null);
    };
  }, [el]);
}
