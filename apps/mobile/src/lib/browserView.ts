// The phone's live-view link to the host (spec/15 § Browser): keeping one view
// of a chat's tab open, and sending what the user does in it. Mirrors
// packages/web/src/lib/browserView.ts.

import { useEffect, useRef, useState } from 'react';
import type { BrowserHandoffInput, BrowserViewInput } from '@patch/wire';
import { getWs } from '../api/ws';

const WATCH_RENEW_MS = 5_000;

export interface ViewerViewport {
  width: number;
  height: number;
  scale: number;
}

/**
 * Keep one view of a chat's tab open while `enabled`. A `viewport` makes it the
 * large view: the host lays the page out at the phone's size and pixel ratio,
 * so the site shows its own phone layout, sharp.
 */
export function useBrowserWatch(
  chatId: string,
  enabled: boolean,
  tabId: string | undefined,
  viewport: ViewerViewport | null,
): void {
  const [viewerId] = useState(() => `m-${Math.random().toString(36).slice(2, 10)}`);
  const vp = useRef(viewport);
  vp.current = viewport;
  const send = useRef((_watch: boolean): void => undefined);
  send.current = (watch: boolean): void =>
    getWs().safeSend({
      type: 'patch.browser_view.watch',
      chatId,
      ...(tabId ? { tabId } : {}),
      watch,
      viewerId,
      ...(watch && vp.current ? { viewport: vp.current } : {}),
    });
  useEffect(() => {
    if (!enabled) return;
    send.current(true);
    const renew = setInterval(() => send.current(true), WATCH_RENEW_MS);
    return () => {
      clearInterval(renew);
      send.current(false);
    };
  }, [enabled, chatId, tabId]);
  const key = viewport ? `${viewport.width}x${viewport.height}@${viewport.scale}` : '';
  useEffect(() => {
    if (enabled && key !== '') send.current(true);
  }, [enabled, key]);
}

/**
 * Send the user's input to the tab: the any-time path on a host that takes it
 * (`inputVersion` 2), else a hand-off's own input during a hand-off.
 */
export function sendInput(
  chatId: string,
  tabId: string,
  modern: boolean,
  handoffId: string | undefined,
  input: BrowserViewInput,
): void {
  if (modern) {
    getWs().safeSend({ type: 'patch.browser_view.input', chatId, tabId, input });
    return;
  }
  if (!handoffId) return;
  const legacy: BrowserHandoffInput | null =
    input.kind === 'pointer' && input.action === 'click'
      ? { kind: 'pointer', action: 'click', x: input.x, y: input.y }
      : input.kind === 'scroll' || input.kind === 'text'
        ? input
        : input.kind === 'key' && (input.action ?? 'press') === 'press'
          ? { kind: 'key', key: input.key }
          : null;
  if (legacy)
    getWs().safeSend({ type: 'patch.browser_handoff.input', chatId, handoffId, input: legacy });
}

export function sendDrive(chatId: string, tabId: string, driver: 'agent' | 'user'): void {
  getWs().safeSend({ type: 'patch.browser_view.drive', chatId, tabId, driver });
}

export function sendDone(chatId: string, handoffId: string, action: 'done' | 'cancel'): void {
  getWs().safeSend({ type: 'patch.browser_handoff.control', chatId, handoffId, action });
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
