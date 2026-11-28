// Handover between surfaces (spec/05 § Handover). One rule: this surface only
// changes screen while the user is not looking at it. A position from another
// surface is applied the moment it arrives if this window is hidden or not
// focused, so coming back finds it already there; one that arrives while the
// window is in use is dropped. This surface reports the page and chat position
// only when they change, and once more as the user leaves the window.

import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { positionFromPath, pathFromPosition } from '../lib/viewPosition.js';
import type { ViewPositionTarget } from '../lib/viewPosition.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useViewPositionStore } from '../stores/viewPositionStore.js';
import type { PatchWs } from '../api/ws.js';

/** Quiet period after the last move before a position is reported. */
export const VIEW_POSITION_DEBOUNCE_MS = 800;

const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/** Whether the user is looking at this window right now. */
function inUse(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function samePosition(a: ViewPositionTarget | null, b: ViewPositionTarget | null): boolean {
  return a !== null && b !== null && a.page === b.page && a.id === b.id && a.seq === b.seq;
}

export function ViewPositionSync({ ws }: { ws: PatchWs | null }): null {
  const location = useLocation();
  // Captures and detached tabs have an explicitly requested screen. They
  // must neither adopt the account's last page nor publish their own position.
  const [isolated] = useState(() => {
    const params = new URLSearchParams(location.search);
    return params.get('tabWindow') === '1' || params.has('capture');
  });
  const navigate = useNavigate();
  const scroll = useViewPositionStore((s) => s.scroll);
  // Account-wide "Sync position between surfaces". Until the preferences have
  // loaded the answer is unknown, so nothing is reported or adopted.
  const enabled = usePreferencesStore((s) => s.loaded && s.preferences.syncPosition) && !isolated;
  // The user has touched this surface since it launched / came to the front.
  const activeRef = useRef(false);
  // Still waiting for the launch snapshot.
  const launchRef = useRef(true);
  // The last position this surface sent, so the same place is never re-sent.
  const sentRef = useRef<ViewPositionTarget | null>(null);
  // Bumped on the first touch after launch / foreground so the page the user is
  // already on is reported without them having to navigate or scroll first.
  const [activations, setActivations] = useState(0);

  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  const current = (): ViewPositionTarget | null => {
    const sc = useViewPositionStore.getState().scroll;
    const path = pathRef.current;
    return positionFromPath(
      path,
      sc !== null && path === `/chats/${encodeURIComponent(sc.chatId)}` ? sc.seq : null,
    );
  };

  const report = (): void => {
    if (!ws || !activeRef.current) return;
    const prefs = usePreferencesStore.getState();
    if (isolated || !prefs.loaded || !prefs.preferences.syncPosition) return;
    const pos = current();
    if (!pos || samePosition(pos, sentRef.current)) return;
    sentRef.current = pos;
    ws.send({ type: 'view_position.set', ...pos });
  };
  const reportRef = useRef(report);
  reportRef.current = report;

  // Decide on the remote position as it arrives: go there while the user is
  // away from this window, drop it while they are using it.
  const settle = (launch: boolean): void => {
    if (isolated) return;
    const st = useViewPositionStore.getState();
    const own = usePresenceStore.getState().surfaceId;
    const r = st.remote;
    const prefs = usePreferencesStore.getState();
    if (!prefs.loaded || !prefs.preferences.syncPosition) return;
    if (!r || r.updatedAt <= st.handledAt) return;
    // Own positions are echoes, except a fresh launch restoring where it closed.
    if (r.surfaceId === own && !launch) return;
    st.markHandled(r.updatedAt);
    if (!launch && inUse()) return;
    // A chat some group already shows is brought forward (spec/14 § Groups).
    // The chat route leaves an already-showing chat alone so a reload keeps the
    // focus it restored, so the handover has to say it means to move there.
    if (r.page === 'chat' && r.id !== undefined) {
      const layout = useLayoutStore.getState();
      if (layout.groups.some((g) => g.chatId === r.id)) layout.showChat(r.id);
    }
    const target = pathFromPosition(r);
    // What this window now shows was chosen elsewhere; it is not news to send back.
    sentRef.current = {
      page: r.page,
      ...(r.id !== undefined ? { id: r.id } : {}),
      ...(r.seq !== undefined ? { seq: r.seq } : {}),
    };
    navigate(target);
  };

  const settleRef = useRef(settle);
  settleRef.current = settle;
  // Decided the moment a position arrives — whether the user is looking at this
  // window is a fact about that moment, not about when React next renders.
  const onRemote = (): void => {
    const st = useViewPositionStore.getState();
    const r = st.remote;
    const prefs = usePreferencesStore.getState();
    if (isolated || !r || !prefs.loaded || !prefs.preferences.syncPosition) return;
    if (launchRef.current) {
      launchRef.current = false;
      // The launch snapshot: open where the user was, unless they already started here.
      if (!activeRef.current) settleRef.current(true);
      else st.markHandled(r.updatedAt);
      return;
    }
    settleRef.current(false);
  };
  const onRemoteRef = useRef(onRemote);
  onRemoteRef.current = onRemote;
  useEffect(
    () =>
      useViewPositionStore.subscribe((s, prev) => {
        if (s.remote !== prev.remote) onRemoteRef.current();
      }),
    [],
  );
  // A snapshot that landed before the preferences loaded is decided once they have.
  useEffect(() => {
    if (enabled) onRemoteRef.current();
  }, [enabled]);

  useEffect(() => {
    const onInput = (): void => {
      if (!activeRef.current) setActivations((n) => n + 1);
      activeRef.current = true;
      launchRef.current = false;
    };
    // Leaving the window: send where the user stopped, once, then stop counting
    // as in use until they touch it again.
    const onLeave = (): void => {
      reportRef.current();
      activeRef.current = false;
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') onLeave();
    };
    for (const e of INPUT_EVENTS) window.addEventListener(e, onInput, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onLeave);
    return () => {
      for (const e of INPUT_EVENTS) window.removeEventListener(e, onInput);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onLeave);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setTimeout(() => reportRef.current(), VIEW_POSITION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [ws, enabled, location.pathname, scroll, activations]);

  return null;
}
