// The live view's link to the host (spec/02 § Browser — Hand-off, Watching
// and stopping): keeping one view of a chat's tab open, and sending what the
// user does in it. Shared by the preview, the large view and the bar.

import { useEffect, useRef, useState } from 'react';
import type { BrowserViewInput, WireEvent } from '@patch/wire';
import { getActiveWs } from '../api/ws.js';
import { useUiStore } from '../stores/uiStore.js';

const WATCH_RENEW_MS = 5_000;

export interface ViewerViewport {
  width: number;
  height: number;
  scale: number;
}

/**
 * Send a frame the user is waiting on. Not connected is said out loud: a
 * click that silently went nowhere would look like a broken page.
 */
export function sendBrowser(event: WireEvent): void {
  const ws = getActiveWs();
  try {
    if (!ws) throw new Error('not connected');
    ws.send(event);
  } catch (err) {
    useUiStore
      .getState()
      .pushError(
        'Not connected — that didn’t reach the browser',
        undefined,
        err instanceof Error ? err.message : String(err),
      );
  }
}

export function sendViewInput(chatId: string, tabId: string, input: BrowserViewInput): void {
  sendBrowser({ type: 'patch.browser_view.input', chatId, tabId, input });
}

/** Pointer moves are many and the next one replaces this one: dropping it offline is fine. */
export function sendViewMove(chatId: string, tabId: string, input: BrowserViewInput): void {
  getActiveWs()?.safeSend({ type: 'patch.browser_view.input', chatId, tabId, input });
}

export function sendDrive(chatId: string, tabId: string, driver: 'agent' | 'user'): void {
  sendBrowser({ type: 'patch.browser_view.drive', chatId, tabId, driver });
}

/**
 * Keep one view of a chat's tab open on the host while `enabled`. A
 * `viewport` makes it the large view: the host lays the page out at that
 * size and pixel ratio. Each mounted view has its own id, so a preview on one
 * screen never undoes the size of a large view on another.
 */
export function useBrowserWatch(
  chatId: string,
  enabled: boolean,
  tabId: string | undefined,
  viewport: ViewerViewport | null,
): void {
  const [viewerId] = useState(() => `v-${Math.random().toString(36).slice(2, 10)}`);
  const vp = useRef(viewport);
  vp.current = viewport;
  const send = (watch: boolean): void =>
    getActiveWs()?.safeSend({
      type: 'patch.browser_view.watch',
      chatId,
      ...(tabId ? { tabId } : {}),
      watch,
      viewerId,
      ...(watch && vp.current ? { viewport: vp.current } : {}),
    });
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    if (!enabled) return;
    sendRef.current(true);
    const renew = setInterval(() => sendRef.current(true), WATCH_RENEW_MS);
    return () => {
      clearInterval(renew);
      sendRef.current(false);
    };
  }, [enabled, chatId, tabId]);
  // A new size is told at once, not at the next renewal.
  const key = viewport ? `${viewport.width}x${viewport.height}@${viewport.scale}` : '';
  useEffect(() => {
    if (enabled && key !== '') sendRef.current(true);
  }, [enabled, key]);
}

/** Re-renders every `ms` while `on`, for a running timer. */
export function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}
