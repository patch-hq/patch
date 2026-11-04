// Why did the server link drop? The socket only says "closed 1006"; the host
// knows more. A laptop that slept (lid closed, or a dark wake) loses its
// connection without any network or server fault, and the log could not tell
// that from a real outage. Sleep is detected by comparing the wall clock with
// a monotonic clock: monotonic time does not advance while the machine is
// suspended on macOS or Linux, so any gap between the two is time spent asleep.

import { CLOSE_SERVER_RESTARTING } from '@patch/wire';

export type DropCause = 'sleep' | 'server-restart' | 'unexplained';

export interface LinkDrop {
  /** ms-epoch the host noticed the drop. */
  at: number;
  cause: DropCause;
  /** Whole seconds asleep, for `sleep`. */
  sleptSeconds?: number;
  /** The WebSocket close code (1006 = no close frame). */
  code: number;
}

/** WebSocket "going away" (1001) and the server's own restart code. */
const PLANNED_CLOSE_CODES: ReadonlySet<number> = new Set([1001, CLOSE_SERVER_RESTARTING]);

/** A gap smaller than this is timer jitter, not sleep. */
export const SLEEP_GAP_MS = 10_000;
/** A sleep counts as the cause of a drop only if it ended this recently. */
export const SLEEP_ATTRIBUTION_MS = 120_000;
const SAMPLE_INTERVAL_MS = 5_000;

export interface SleepDetector {
  start(): void;
  stop(): void;
  /** Compare the clocks now; records any sleep since the last sample. */
  sample(): void;
  /** The most recent sleep, or undefined if none has been seen. */
  lastSleep(): { endedAt: number; ms: number } | undefined;
}

export interface SleepDetectorOptions {
  /** Test hooks. */
  wallNow?: () => number;
  monoNow?: () => number;
  intervalMs?: number;
}

export function createSleepDetector(opts: SleepDetectorOptions = {}): SleepDetector {
  const wallNow = opts.wallNow ?? (() => Date.now());
  const monoNow = opts.monoNow ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  let lastWall = wallNow();
  let lastMono = monoNow();
  let last: { endedAt: number; ms: number } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const sample = (): void => {
    const wall = wallNow();
    const mono = monoNow();
    const gap = wall - lastWall - (mono - lastMono);
    lastWall = wall;
    lastMono = mono;
    if (gap >= SLEEP_GAP_MS) last = { endedAt: wall, ms: gap };
  };

  return {
    start(): void {
      if (timer) return;
      lastWall = wallNow();
      lastMono = monoNow();
      timer = setInterval(sample, opts.intervalMs ?? SAMPLE_INTERVAL_MS);
      timer.unref();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    sample,
    lastSleep: () => last,
  };
}

/** Decide the cause of a close. Planned server restarts win; then sleep; else unexplained. */
export function classifyDrop(
  code: number,
  detector: SleepDetector,
  now: number = Date.now(),
): LinkDrop {
  if (PLANNED_CLOSE_CODES.has(code)) return { at: now, cause: 'server-restart', code };
  detector.sample();
  const sleep = detector.lastSleep();
  if (sleep && now - sleep.endedAt <= SLEEP_ATTRIBUTION_MS) {
    return { at: now, cause: 'sleep', sleptSeconds: Math.round(sleep.ms / 1000), code };
  }
  return { at: now, cause: 'unexplained', code };
}

/** The log line for a drop. */
export function describeDrop(drop: LinkDrop): string {
  switch (drop.cause) {
    case 'sleep':
      return `machine slept for ${drop.sleptSeconds}s`;
    case 'server-restart':
      return 'server restarting (planned)';
    case 'unexplained':
      return 'unexplained drop';
  }
}
