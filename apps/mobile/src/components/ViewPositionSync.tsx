// Handover between surfaces (spec/05 § Handover). One rule: the phone only
// changes screen while the user is not looking at it.
//
// - A position from another surface that arrives while the phone is put away
//   (by silent push, or over a socket still open in the background) is applied
//   at once, so picking the phone up finds it already there.
// - One that arrives while the phone is in use is dropped.
// - A cold start opens straight onto the newest position it holds, before the
//   socket has connected.
// - If the phone comes to the front and the connect snapshot shows a newer
//   move it never got (no push), it does not move: it offers "Continue from …"
//   for 5 s (HandoverChip).
// - The phone reports its own position only when it changes, and once more as
//   it is put away.

import React from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';
import type { Href } from 'expo-router';
import { getWs } from '../api/ws';
import { setWatchdogRoute } from '../lib/stallWatchdog';
import { useCurrentRoute } from '../lib/currentRoute';
import { positionFromRoute, routeFromPosition } from '../lib/viewPosition';
import type { ViewPositionTarget } from '../lib/viewPosition';
import {
  logDecision,
  readHandledAt,
  readLast,
  readSyncEnabled,
  setHandoverPushListener,
  writeHandledAt,
  writeLast,
  writeSyncEnabled,
  type HandoverPosition,
  type HandoverVia,
} from '../lib/handover';
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
// This phone's clock: when the app last came to the front.
let foregroundAt = Date.now();
// The last position this phone sent or was moved to, so the same place is never sent.
let sent: ViewPositionTarget | null = null;
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
 * the user acting here: no handover replaces the screen they asked for.
 */
export function noteExplicitNavigation(now: number = Date.now()): void {
  lastInputAt = now;
}

/** Test seam: back to a fresh launch. */
export function resetViewPositionSync(now: number = Date.now()): void {
  active = false;
  lastInputAt = Number.NEGATIVE_INFINITY;
  foregroundAt = now;
  sent = null;
}

function samePlace(a: ViewPositionTarget | null, b: ViewPositionTarget | null): boolean {
  return a !== null && b !== null && a.page === b.page && a.id === b.id && a.seq === b.seq;
}

function target(p: HandoverPosition): ViewPositionTarget {
  return {
    page: p.page,
    ...(p.id !== undefined ? { id: p.id } : {}),
    ...(p.seq !== undefined ? { seq: p.seq } : {}),
  };
}

/** The phone is in the user's hand right now. */
function inUse(): boolean {
  return AppState.currentState === 'active';
}

export function ViewPositionSync(): null {
  const router = useRouter();
  const { pathname, id, ready: navReady } = useCurrentRoute();
  React.useEffect(() => setWatchdogRoute(pathname), [pathname]);
  const scroll = useViewPositionStore((s) => s.scroll);
  // Account-wide "Sync position between surfaces". Until the settings have
  // loaded the answer is the one last loaded (kept across runs, so a cold start
  // can open straight onto a position); before it was ever loaded, unknown.
  const loaded = useSettingsStore((s) => s.data?.preferences.syncPosition);
  const enabled = loaded ?? readSyncEnabled() ?? false;
  React.useEffect(() => {
    if (loaded !== undefined) writeSyncEnabled(loaded);
  }, [loaded]);

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
  const navReadyRef = React.useRef(navReady);
  navReadyRef.current = navReady;
  const routeRef = React.useRef({ pathname, id });
  routeRef.current = { pathname, id };

  const go = React.useCallback(
    (p: HandoverPosition, via: HandoverVia, why: string): void => {
      writeHandledAt(p.updatedAt);
      sent = target(p);
      logDecision(p, via, 'applied', why);
      router.navigate(routeFromPosition(p) as Href);
    },
    [router],
  );

  const drop = (p: HandoverPosition, via: HandoverVia, why: string): void => {
    writeHandledAt(p.updatedAt);
    logDecision(p, via, 'dropped', why);
  };

  // A position from another surface arrived, live (push or socket).
  const decide = React.useCallback(
    (p: HandoverPosition, via: HandoverVia, snapshot: boolean): void => {
      if (!enabledRef.current || p.updatedAt <= readHandledAt()) return;
      const own = p.surfaceId === usePresenceStore.getState().surfaceId;
      if (own) {
        // This phone's own report coming back: it is already there.
        writeHandledAt(p.updatedAt);
        writeLast(p);
        return;
      }
      writeLast(p);
      if (!navReadyRef.current) return; // the launch effect below takes it
      if (!inUse()) {
        go(p, via, 'arrived while the phone was put away');
        return;
      }
      // In the hand. A connect snapshot before any touch is a move the push
      // never brought: offer it, never take it.
      if (snapshot && lastInputAt < foregroundAt) {
        writeHandledAt(p.updatedAt);
        logDecision(p, via, 'offered', 'missed while away; shown as Continue from');
        useViewPositionStore.getState().setOffer({ ...p, snapshot });
        return;
      }
      drop(p, via, 'arrived while the phone was in use');
    },
    [go],
  );
  const decideRef = React.useRef(decide);
  decideRef.current = decide;

  // Pushes, while the app is alive.
  React.useEffect(() => {
    setHandoverPushListener((p) => decideRef.current(p, 'push', false));
    return () => setHandoverPushListener(null);
  }, []);

  // The socket: decided the moment each position arrives.
  React.useEffect(
    () =>
      useViewPositionStore.subscribe((s, prev) => {
        if (s.remote === null || s.remote === prev.remote) return;
        decideRef.current(s.remote, 'socket', s.remote.snapshot);
      }),
    [],
  );

  // Launch: open straight onto the newest position held, before the socket.
  const launched = React.useRef(false);
  React.useEffect(() => {
    if (launched.current || !navReady || !enabled) return;
    launched.current = true;
    const last = readLast();
    if (!last) return;
    if (lastInputAt > Number.NEGATIVE_INFINITY) {
      drop(last, 'launch', 'opened for something else (a notification, a link)');
      return;
    }
    const own = last.surfaceId === usePresenceStore.getState().surfaceId;
    if (own || last.updatedAt > readHandledAt()) {
      go(
        last,
        'launch',
        own ? 'reopened where this phone closed' : 'arrived while the app was closed',
      );
    }
  }, [navReady, enabled, go]);

  // Report this phone's position.
  const report = React.useCallback((): void => {
    if (!enabledRef.current || !active) return;
    const { pathname: path, id: routeId } = routeRef.current;
    const sc = useViewPositionStore.getState().scroll;
    const chatPath = sc === null ? null : `/chats/${sc.chatId}`;
    const pos = positionFromRoute(
      path,
      { ...(routeId !== undefined ? { id: routeId } : {}) },
      path === chatPath && sc !== null ? sc.seq : null,
    );
    if (!pos || samePlace(pos, sent)) return;
    sent = pos;
    getWs().safeSend({ type: 'view_position.set', ...pos });
  }, []);

  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        foregroundAt = Date.now();
        return;
      }
      // Put away: where the user stopped, once; then no longer in use.
      report();
      active = false;
      useViewPositionStore.getState().setOffer(null);
    });
    return () => sub.remove();
  }, [report]);

  React.useEffect(() => {
    if (!enabled) return undefined;
    const timer = setTimeout(() => {
      if (AppState.currentState === 'active') report();
    }, VIEW_POSITION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, pathname, id, scroll, activations, report]);

  return null;
}

/** Take up an offered position (HandoverChip's tap). */
export function acceptOffer(navigate: (href: Href) => void): void {
  const st = useViewPositionStore.getState();
  const p = st.offer;
  if (!p) return;
  st.setOffer(null);
  sent = target(p);
  noteExplicitNavigation();
  logDecision(p, 'socket', 'applied', 'Continue from tapped');
  navigate(routeFromPosition(p) as Href);
}

/** Let an offered position go (swiped away or ran out). */
export function dismissOffer(why: string): void {
  const st = useViewPositionStore.getState();
  const p = st.offer;
  if (!p) return;
  st.setOffer(null);
  logDecision(p, 'socket', 'dropped', why);
}
