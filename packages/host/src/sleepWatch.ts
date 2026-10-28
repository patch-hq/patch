// Knows whether the machine is properly awake. The sleep guard keeps a Mac
// awake while it can, but a closed lid on battery sleeps regardless, and the
// Mac then spends the night in short maintenance wakes ("dark wakes") with no
// display. Work started in one dies when the Mac drops back to sleep, so a
// turn waits for a full wake before it calls the model.
//
// macOS says which wake it is in: `pmset -g systemstate` lists the system's
// current capabilities, and Graphics is present only in a full wake. That is
// asked, not guessed — a dark wake that runs long is still a dark wake.
//
// Separately, timers do not fire while the machine sleeps, so a tick that lands
// long after it was due means the machine slept through the gap. A turn that
// failed across such a gap died of the sleep, not of anything it did.

import { execFileSync } from 'node:child_process';
import { loadavg } from 'node:os';
import type { Logger } from 'pino';

export interface SleepWatch {
  /** Look at the clock now rather than waiting for the next tick. */
  check(): void;
  /** Whether the machine has slept at any point after wall-clock `ts`. */
  sleptSince(ts: number): boolean;
  /** Whether the machine is in a full wake, not a dark wake. Always true off macOS. */
  isFullyAwake(): boolean;
  dispose(): void;
}

export interface SleepWatchOptions {
  logger: Logger;
  platform?: NodeJS.Platform;
  now?: () => number;
  tickMs?: number;
  /** How late a tick has to be before it counts as sleep, not a busy event loop. */
  gapMs?: number;
  /** The output of `pmset -g systemstate`. */
  readSystemState?: () => string;
  /** CPU time this process has used, in ms (tests). */
  cpuMs?: () => number;
  /**
   * Called when a tick lands far later than it was due. The sockets this
   * process held across the gap are not to be trusted: the caller should make
   * them re-handshake rather than wait for them to notice.
   */
  onGap?: (gap: { sleptMs: number }) => void;
}

const CAPABILITIES = /Current System Capabilities are:(.*)/;

export function createSleepWatch(opts: SleepWatchOptions): SleepWatch {
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? Date.now;
  const tickMs = opts.tickMs ?? 5_000;
  const gapMs = opts.gapMs ?? 30_000;
  const readSystemState =
    opts.readSystemState ??
    (() =>
      execFileSync('/usr/bin/pmset', ['-g', 'systemstate'], { encoding: 'utf8', timeout: 5_000 }));
  const cpuMs =
    opts.cpuMs ??
    ((): number => {
      const u = process.cpuUsage();
      return (u.user + u.system) / 1000;
    });
  let lastTick = now();
  let lastCpu = cpuMs();
  let lastWakeAt: number | null = null;

  const check = (): void => {
    const t = now();
    const cpu = cpuMs();
    if (t - lastTick > tickMs + gapMs) {
      lastWakeAt = t;
      const sleptMs = t - lastTick;
      if (platform === 'darwin') {
        opts.logger.info({ sleptMs }, 'sleep watch: machine was asleep');
      } else {
        // A server does not sleep, so a gap here is this process not running:
        // either its event loop was blocked (it used the CPU the whole time) or
        // it was stopped or starved (it used almost none). Say which, with the
        // machine's load, so the next one is diagnosed from the log rather than
        // guessed at from its symptoms.
        const cpuUsedMs = Math.round(cpu - lastCpu);
        opts.logger.error(
          {
            sleptMs,
            cpuUsedMs,
            kind: cpuUsedMs >= sleptMs / 2 ? 'event loop blocked' : 'process stopped or starved',
            loadavg: loadavg().map((n) => Math.round(n * 100) / 100),
            rssMb: Math.round(process.memoryUsage.rss() / 1048576),
          },
          'sleep watch: this process did not run for a long gap',
        );
      }
      opts.onGap?.({ sleptMs });
    }
    lastTick = t;
    lastCpu = cpu;
  };

  const isFullyAwake = (): boolean => {
    if (platform !== 'darwin') return true;
    let out: string;
    try {
      out = readSystemState();
    } catch (err) {
      // Not knowing must not hold every turn forever. Loud, so a broken check
      // is seen rather than quietly turning back into the old behaviour.
      opts.logger.error(
        { err },
        'sleep watch: pmset -g systemstate failed — running the turn without knowing the wake state',
      );
      return true;
    }
    const caps = CAPABILITIES.exec(out)?.[1];
    if (caps === undefined) {
      opts.logger.error(
        { out },
        'sleep watch: pmset -g systemstate gave no capabilities — running the turn without knowing the wake state',
      );
      return true;
    }
    return /\bGraphics\b/.test(caps);
  };

  const timer = setInterval(check, tickMs);
  timer.unref?.();

  return {
    check,
    sleptSince: (ts) => lastWakeAt !== null && lastWakeAt > ts,
    isFullyAwake,
    dispose: () => clearInterval(timer),
  };
}
