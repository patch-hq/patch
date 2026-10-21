// Notices when the machine has been asleep. The sleep guard keeps a Mac awake
// while it can, but a closed lid on battery sleeps regardless, and the Mac
// then runs in seconds-long maintenance wakes all night. A turn dies in each
// one, and the retry ladder spent its three rungs in the next three — so a
// 3am job was left errored by morning without ever having been awake to run.
//
// Timers do not fire while the machine sleeps, so a tick that lands long
// after it was due means the machine slept through the gap. `awakeForMs`
// is how long it has been awake since: a maintenance wake never gets past a
// minute, so a few minutes means the machine is genuinely back.

import type { Logger } from 'pino';

export interface SleepWatch {
  /** Look at the clock now rather than waiting for the next tick. */
  check(): void;
  /** Whether the machine has slept at any point after wall-clock `ts`. */
  sleptSince(ts: number): boolean;
  /** How long the machine has been continuously awake. */
  awakeForMs(): number;
  dispose(): void;
}

export interface SleepWatchOptions {
  logger: Logger;
  now?: () => number;
  tickMs?: number;
  /** How late a tick has to be before it counts as sleep, not a busy event loop. */
  gapMs?: number;
}

export function createSleepWatch(opts: SleepWatchOptions): SleepWatch {
  const now = opts.now ?? Date.now;
  const tickMs = opts.tickMs ?? 5_000;
  const gapMs = opts.gapMs ?? 30_000;
  const startedAt = now();
  let lastTick = startedAt;
  let lastWakeAt: number | null = null;
  let lastSleepStart: number | null = null;

  const check = (): void => {
    const t = now();
    if (t - lastTick > tickMs + gapMs) {
      lastSleepStart = lastTick;
      lastWakeAt = t;
      opts.logger.info({ sleptMs: t - lastTick }, 'sleep watch: machine was asleep');
    }
    lastTick = t;
  };

  const timer = setInterval(check, tickMs);
  timer.unref?.();

  return {
    check,
    sleptSince: (ts) => lastWakeAt !== null && lastWakeAt > ts && lastSleepStart !== null,
    awakeForMs: () => now() - (lastWakeAt ?? startedAt),
    dispose: () => clearInterval(timer),
  };
}
