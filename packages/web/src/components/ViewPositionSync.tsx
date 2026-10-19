// Handover between surfaces (spec/05 § Handover). Reports the page and chat
// scroll position the user is on, and adopts another surface's newer position
// on launch or when this surface returns to the foreground — never while the
// user is mid-use, so a screen does not move under a hand.

import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { positionFromPath, pathFromPosition } from '../lib/viewPosition.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useViewPositionStore } from '../stores/viewPositionStore.js';
import type { PatchWs } from '../api/ws.js';

/** Quiet period after the last move before a position is reported. */
export const VIEW_POSITION_DEBOUNCE_MS = 800;

const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function ViewPositionSync({ ws }: { ws: PatchWs | null }): null {
  const location = useLocation();
  const navigate = useNavigate();
  const remote = useViewPositionStore((s) => s.remote);
  const scroll = useViewPositionStore((s) => s.scroll);
  // Account-wide "Sync position between surfaces". Until the preferences have
  // loaded the answer is unknown, so nothing is reported or adopted.
  const enabled = usePreferencesStore((s) => s.loaded && s.preferences.syncPosition);
  // The user has touched this surface since it launched / came to the front.
  const activeRef = useRef(false);
  // Still waiting for the launch snapshot.
  const launchRef = useRef(true);
  // Bumped on the first touch after launch / foreground so the page the user is
  // already on is reported without them having to navigate or scroll first.
  const [activations, setActivations] = useState(0);

  const adopt = (allowOwn = false): void => {
    const st = useViewPositionStore.getState();
    const own = usePresenceStore.getState().surfaceId;
    const r = st.remote;
    if (
      !usePreferencesStore.getState().preferences.syncPosition ||
      !usePreferencesStore.getState().loaded
    )
      return;
    if (!r || (r.surfaceId === own && !allowOwn) || r.updatedAt <= st.handledAt) return;
    st.markHandled(r.updatedAt);
    navigate(pathFromPosition(r));
  };

  useEffect(() => {
    if (enabled && remote && launchRef.current && !activeRef.current) {
      launchRef.current = false;
      adopt(true);
    }
  }, [remote, enabled]);

  useEffect(() => {
    const onInput = (): void => {
      if (!activeRef.current) setActivations((n) => n + 1);
      activeRef.current = true;
      launchRef.current = false;
    };
    const onForeground = (): void => {
      if (document.visibilityState === 'hidden') {
        activeRef.current = false;
        return;
      }
      activeRef.current = false;
      adopt();
    };
    for (const e of INPUT_EVENTS) window.addEventListener(e, onInput, { passive: true });
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('focus', onForeground);
    return () => {
      for (const e of INPUT_EVENTS) window.removeEventListener(e, onInput);
      document.removeEventListener('visibilitychange', onForeground);
      window.removeEventListener('focus', onForeground);
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!enabled || !ws || !activeRef.current || document.visibilityState === 'hidden') return;
      const pos = positionFromPath(
        location.pathname,
        scroll !== null && location.pathname === `/chats/${encodeURIComponent(scroll.chatId)}`
          ? scroll.seq
          : null,
      );
      if (pos) ws.send({ type: 'view_position.set', ...pos });
    }, VIEW_POSITION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [ws, enabled, location.pathname, scroll, activations]);

  return null;
}
