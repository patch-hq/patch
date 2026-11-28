// Handover between surfaces (spec/05 § Handover). Reports the page and chat
// scroll position the user is on, and adopts another surface's position only
// when that surface acted after the user's last touch here. It is applied the
// moment it arrives — in the background too, so the phone is already on it
// when opened — unless the user is using the phone right now, and is dropped
// for good once the user does anything here after it arrived.

import React from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';
import type { Href } from 'expo-router';
import { getWs } from '../api/ws';
import { setWatchdogRoute } from '../lib/stallWatchdog';
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
// This phone's clock: the user's last touch or deliberate navigation.
let lastInputAt = Number.NEGATIVE_INFINITY;
// The report below is scheduled from route/scroll changes; a first touch after
// launch or foreground changes neither, so it has to wake the report itself.
const activatedListeners = new Set<() => void>();

export function noteUserInput(now: number = Date.now()): void {
  const wasActive = active;
  active = true;
  lastInputAt = now;
  if (!wasActive) for (const l of activatedListeners) l();
}

/**
 * A deliberate navigation (a notification tap, a deep link, a share) counts as
 * the user acting here, so no position that arrived before it can replace the
 * screen they asked for — including a reconnect snapshot that lands after it.
 */
export function noteExplicitNavigation(now: number = Date.now()): void {
  lastInputAt = now;
}

/** Test seam: back to a fresh launch. */
export function resetViewPositionSync(): void {
  active = false;
  lastInputAt = Number.NEGATIVE_INFINITY;
}

export function ViewPositionSync(): null {
  const router = useRouter();
  const { pathname, id, ready: navReady } = useCurrentRoute();
  React.useEffect(() => setWatchdogRoute(pathname), [pathname]);
  const remote = useViewPositionStore((s) => s.remote);
  const scroll = useViewPositionStore((s) => s.scroll);
  // Account-wide "Sync position between surfaces". Until the settings have
  // loaded the answer is unknown, so nothing is reported or adopted.
  const enabled = useSettingsStore((s) => s.data?.preferences.syncPosition === true);

  React.useEffect(() => {
    if (useSettingsStore.getState().data === null) void useSettingsStore.getState().load();
  }, []);

  // Bumped when the user first touches the surface, so the chat they are
  // already on is reported without needing to navigate or scroll first.
  const [activations, setActivations] = React.useState(0);
  React.useEffect(() => {
    const l = (): void => setActivations((n) => n + 1);
    activatedListeners.add(l);
    return () => {
      activatedListeners.delete(l);
    };
  }, []);

  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;

  // Decide on the remote position: apply it, drop it, or leave it waiting
  // while the user is using the phone.
  const settle = React.useCallback((): void => {
    const st = useViewPositionStore.getState();
    const r = st.remote;
    if (!navReady || !r || !enabledRef.current) return;
    if (r.updatedAt <= st.handledAt) return;
    // Own positions are echoes, except a restart restoring where it closed.
    const own = r.surfaceId === usePresenceStore.getState().surfaceId;
    if (own && !r.restore) return;
    // The user did something here after it arrived: what they did wins.
    if (r.arrivedAt <= lastInputAt) {
      st.markHandled(r.updatedAt);
      return;
    }
    // Never move a screen under a hand; decided when the phone is put away.
    if (active && AppState.currentState === 'active') return;
    st.markHandled(r.updatedAt);
    router.navigate(routeFromPosition(r) as Href);
  }, [navReady, router]);

  React.useEffect(() => {
    if (enabled) settle();
  }, [remote, navReady, enabled, settle]);

  React.useEffect(() => {
    const sub = AppState.addEventListener('change', () => {
      active = false;
      settle();
    });
    return () => sub.remove();
  }, [settle]);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      if (!enabled || !active || AppState.currentState !== 'active') return;
      const chatPath = scroll === null ? null : `/chats/${scroll.chatId}`;
      const pos = positionFromRoute(
        pathname,
        { ...(id !== undefined ? { id } : {}) },
        pathname === chatPath && scroll !== null ? scroll.seq : null,
      );
      if (pos) getWs().safeSend({ type: 'view_position.set', ...pos });
    }, VIEW_POSITION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, pathname, id, scroll, activations]);

  return null;
}
