// JS stall watchdog: when the app stops responding, what was it doing?
//
// A timer ticks every TICK_MS. If it fires much later than due, the JS thread
// was blocked in between; the gap is logged to the on-device Exits log with the
// screen, any open overlay and the last few things that happened. JS cannot run
// while it is blocked, so the context is also saved to the session marker as it
// changes: a freeze that never recovers is then named on the next launch.
//
// A stall over REPORT_STALL_MS that recovers is also handed to `onLongStall`, so
// it reaches the host log without anyone reading the phone (crashReport.ts).

import { AppState } from 'react-native';
import { logExit, noteContext } from './exitLog';

const TICK_MS = 500;
const STALL_MS = 2_000;
/** A stall this long is reported off the phone as well as logged on it. */
export const REPORT_STALL_MS = 10_000;
const MAX_CRUMBS = 8;

let route = '';
const overlays = new Map<number, string>();
let nextOverlayId = 1;
const crumbs: string[] = [];

export function setWatchdogRoute(pathname: string): void {
  route = pathname;
  noteCrumb(`route ${pathname || '(none)'}`);
}

/** Something that ran or happened: kept as the last few crumbs. */
export function noteCrumb(label: string): void {
  crumbs.push(`${new Date().toISOString().slice(11, 19)} ${label}`);
  if (crumbs.length > MAX_CRUMBS) crumbs.shift();
}

/**
 * An overlay is open (a menu, a sheet). Returns the call that marks it closed.
 * Non-modal overlays matter most: they sit over the screen and can swallow touches.
 */
export function registerOverlay(name: string): () => void {
  const id = nextOverlayId++;
  overlays.set(id, name);
  noteCrumb(`open ${name}`);
  return () => {
    overlays.delete(id);
    noteCrumb(`close ${name}`);
  };
}

export function describeContext(): string {
  const open = [...overlays.values()];
  return [
    `screen ${route || '(none)'}`,
    `overlays ${open.length ? open.join(', ') : 'none'}`,
    `recent ${crumbs.length ? crumbs.join(' | ') : 'none'}`,
  ].join('; ');
}

/** Start ticking. Returns a teardown. */
export function startStallWatchdog(onLongStall: (detail: string, at: number) => void): () => void {
  let last = Date.now();
  let saved = '';
  const timer = setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    last = now;
    const context = describeContext();
    if (AppState.currentState === 'active' && gap - TICK_MS >= STALL_MS) {
      const blocked = gap - TICK_MS;
      const detail = `JS thread blocked for ${(blocked / 1000).toFixed(1)}s; ${context}`.slice(
        0,
        600,
      );
      logExit('stall', detail, now);
      if (blocked >= REPORT_STALL_MS) onLongStall(detail, now);
    }
    if (context !== saved) {
      saved = context;
      noteContext(context);
    }
  }, TICK_MS);
  return () => clearInterval(timer);
}
