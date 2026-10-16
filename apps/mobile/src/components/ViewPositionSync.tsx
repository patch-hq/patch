// Handover between surfaces (spec/05 § Handover). Reports the page and chat
// scroll position the user is on, and adopts another surface's newer position
// on launch or when the app returns to the foreground — never while the user
// is mid-use, so a screen does not move under a thumb.

import React from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';
import type { Href } from 'expo-router';
import { getWs } from '../api/ws';
import { useCurrentRoute } from '../lib/currentRoute';
import { positionFromRoute, routeFromPosition } from '../lib/viewPosition';
import { usePresenceStore } from '../stores/presenceStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useViewPositionStore } from '../stores/viewPositionStore';

/** Quiet period after the last move before a position is reported. */
export const VIEW_POSITION_DEBOUNCE_MS = 800;

// The user has touched this surface since it launched / came to the front.
// Module-level so the root layout's touch capture can set it.
let active = false;
let launching = true;

export function noteUserInput(): void {
  active = true;
  launching = false;
}

/**
 * How long a deliberate navigation (a notification tap, a deep link, a share)
 * holds the screen against handover. The tap foregrounds the app, and Android
 * delivers the link a moment before the app reports itself active — so without
 * this the foreground adoption lands second and replaces the screen the user
 * asked for with whatever another surface was last looking at.
 */
export const EXPLICIT_NAV_HOLD_MS = 5_000;
let explicitNavAt = Number.NEGATIVE_INFINITY;

export function noteExplicitNavigation(now: number = Date.now()): void {
  explicitNavAt = now;
  // Also stops a launch snapshot that arrives later from overriding it.
  launching = false;
}

/** Test seam: back to a fresh launch. */
export function resetViewPositionSync(): void {
  active = false;
  launching = true;
  explicitNavAt = Number.NEGATIVE_INFINITY;
}

export function ViewPositionSync(): null {
  const router = useRouter();
  const { pathname, id, ready: navReady } = useCurrentRoute();
  const remote = useViewPositionStore((s) => s.remote);
  const scroll = useViewPositionStore((s) => s.scroll);
  // Account-wide "Sync position between surfaces". Until the settings have
  // loaded the answer is unknown, so nothing is reported or adopted.
  const enabled = useSettingsStore((s) => s.data?.preferences.syncPosition === true);

  React.useEffect(() => {
    if (useSettingsStore.getState().data === null) void useSettingsStore.getState().load();
  }, []);

  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;

  const adopt = React.useCallback((): void => {
    const st = useViewPositionStore.getState();
    const r = st.remote;
    if (!navReady || !r || !enabledRef.current) return;
    if (r.surfaceId === usePresenceStore.getState().surfaceId || r.updatedAt <= st.handledAt)
      return;
    st.markHandled(r.updatedAt);
    if (Date.now() - explicitNavAt < EXPLICIT_NAV_HOLD_MS) return;
    router.navigate(routeFromPosition(r) as Href);
  }, [navReady, router]);

  React.useEffect(() => {
    // A launch snapshot that lands before the navigator mounts waits for it.
    if (enabled && remote && navReady && launching && !active) {
      launching = false;
      adopt();
    }
  }, [remote, navReady, adopt, enabled]);

  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      active = false;
      if (state === 'active') adopt();
    });
    return () => sub.remove();
  }, [adopt]);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      if (!enabled || !active || AppState.currentState !== 'active') return;
      const chatPath = scroll === null ? null : `/chats/${scroll.chatId}`;
      const pos = positionFromRoute(
        pathname,
        { ...(id !== undefined ? { id } : {}) },
        pathname === chatPath && scroll !== null ? scroll.seq : null,
      );
      if (pos) getWs().send({ type: 'view_position.set', ...pos });
    }, VIEW_POSITION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, pathname, id, scroll]);

  return null;
}
