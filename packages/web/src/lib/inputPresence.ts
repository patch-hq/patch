// How long since the user last touched this computer (spec/09 § Presence
// heuristic), for the `surface.input` report the server routes notifications
// by: at the computer, a notification goes to the desktop and the phone stays
// in the pocket; away from it, the phone.
//
// In the desktop app the answer is the whole host's input idle time, so
// typing in any app counts, and it says when the host is locked or asleep.
// A browser tab cannot see past its own page unless the user has granted idle
// detection (Settings → Notifications); then it reports the whole host too.
// Otherwise the answer is input on this page — a narrower question, and the
// report says which one it answered.

import type { WireEvent } from '@patch/wire';
import { getDesktopBridge } from './desktopBridge.js';

/** How often a surface reports. The server treats three missed reports as silence. */
export const INPUT_REPORT_INTERVAL_MS = 15_000;

type InputReport = Extract<WireEvent, { type: 'surface.input' }>;

let lastPageInputAt = Date.now();
let listening = false;

function markInput(): void {
  lastPageInputAt = Date.now();
}

/** Start noting input on this page. Idempotent. */
export function listenForPageInput(): void {
  /* v8 ignore next -- jsdom always defines `window`; this SSR guard can't be hit under vitest+jsdom. */
  if (listening || typeof window === 'undefined') return;
  listening = true;
  for (const type of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart']) {
    window.addEventListener(type, markInput, { capture: true, passive: true });
  }
}

/** The part of the browser's `IdleDetector` this uses (Chromium, secure contexts only). */
interface IdleDetectorLike extends EventTarget {
  userState: 'active' | 'idle' | null;
  screenState: 'locked' | 'unlocked' | null;
  start(options: { threshold: number; signal?: AbortSignal }): Promise<void>;
}
interface IdleDetectorCtor {
  new (): IdleDetectorLike;
  requestPermission(): Promise<'granted' | 'denied'>;
}

/** The browser's minimum threshold, and so the finest it can tell idle from active. */
export const IDLE_DETECTOR_THRESHOLD_MS = 60_000;

function idleDetectorCtor(): IdleDetectorCtor | undefined {
  if (typeof window === 'undefined' || !window.isSecureContext) return undefined;
  return (window as unknown as { IdleDetector?: IdleDetectorCtor }).IdleDetector;
}

/** Whether this browser can be asked for idle detection. Never true in the desktop app. */
export function idleDetectionSupported(): boolean {
  return getDesktopBridge() === undefined && idleDetectorCtor() !== undefined;
}

export type IdleDetectionState = 'unsupported' | 'prompt' | 'granted' | 'denied';

let detector: IdleDetectorLike | null = null;
/** When the detector last said the host went idle, backdated by its threshold. */
let idleSince: number | null = null;
let detectionChanged: (() => void) | null = null;

/** Called when the browser's view of lock or idle changes, so the caller can report at once. */
export function onIdleDetectionChange(cb: (() => void) | null): void {
  detectionChanged = cb;
}

/** Whether idle detection is available, asked for, granted or refused — without prompting. */
export async function idleDetectionState(): Promise<IdleDetectionState> {
  if (!idleDetectionSupported()) return 'unsupported';
  const status = await navigator.permissions.query({ name: 'idle-detection' as PermissionName });
  return status.state;
}

/** From a click only: the browser asks permission on a user gesture. */
export async function requestIdleDetection(): Promise<IdleDetectionState> {
  const Ctor = idleDetectorCtor();
  if (!Ctor || !idleDetectionSupported()) return 'unsupported';
  const result = await Ctor.requestPermission();
  if (result === 'granted') await startIdleDetection();
  return result;
}

/** Start watching if the user has already granted it. Idempotent. */
export async function startIdleDetection(now: () => number = Date.now): Promise<void> {
  const Ctor = idleDetectorCtor();
  if (!Ctor || detector || !idleDetectionSupported()) return;
  if ((await idleDetectionState()) !== 'granted') return;
  const d = new Ctor();
  d.addEventListener('change', () => {
    idleSince = d.userState === 'idle' ? now() - IDLE_DETECTOR_THRESHOLD_MS : null;
    detectionChanged?.();
  });
  await d.start({ threshold: IDLE_DETECTOR_THRESHOLD_MS });
  // The first state is read straight after start; `change` fires only on a change.
  idleSince = d.userState === 'idle' ? now() - IDLE_DETECTOR_THRESHOLD_MS : null;
  detector = d;
}

/**
 * The report to send now. Rejects when the desktop shell cannot say — a
 * shell that has the method but fails is an error to see, not a reason to
 * quietly report the page's narrower answer as if it were the host's.
 */
export async function readInputReport(now: number = Date.now()): Promise<InputReport> {
  const bridge = getDesktopBridge();
  if (bridge?.getSystemPresence) {
    const { idleMs, away } = await bridge.getSystemPresence();
    return {
      type: 'surface.input',
      idleMs: Math.max(0, Math.round(idleMs)),
      scope: 'system',
      ...(away ? { away } : {}),
    };
  }
  if (bridge?.getSystemIdleMs) {
    const idleMs = Math.max(0, Math.round(await bridge.getSystemIdleMs()));
    return { type: 'surface.input', idleMs, scope: 'system' };
  }
  const pageIdle = Math.max(0, now - lastPageInputAt);
  if (detector) {
    if (detector.screenState === 'locked') {
      return { type: 'surface.input', idleMs: pageIdle, scope: 'system', away: 'locked' };
    }
    // Active means the host saw input inside the threshold, whatever this page saw.
    const idleMs =
      idleSince !== null
        ? Math.max(0, now - idleSince)
        : Math.min(pageIdle, IDLE_DETECTOR_THRESHOLD_MS - 1);
    return { type: 'surface.input', idleMs, scope: 'system' };
  }
  return { type: 'surface.input', idleMs: pageIdle, scope: 'page' };
}

/** Test seam. */
export function __setLastPageInputAt(at: number): void {
  lastPageInputAt = at;
}

/** Test seam. */
export function __resetIdleDetection(): void {
  detector = null;
  idleSince = null;
  detectionChanged = null;
}
