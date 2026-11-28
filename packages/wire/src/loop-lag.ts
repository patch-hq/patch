// Event-loop lag measurement (spec/07 § A dropped call comes back). A process
// that cannot run its timers for a while cannot answer a heartbeat, so a stall
// looks like a dropped line from the other end. This only measures: it never
// acts on a stall, it reports one that exceeds a threshold so the cause of real
// stalls can be found.

/** A stall this long is logged by the host and the server. */
export const LOOP_LAG_LOG_MS = 250;

export interface LoopLagOptions {
  /** A tick this much later than scheduled is reported. */
  thresholdMs: number;
  /** How often the loop is sampled. */
  intervalMs?: number;
  onLag: (lagMs: number) => void;
  now?: () => number;
}

/** Start sampling; returns a function that stops it. The timer never holds the process open. */
export function watchLoopLag(opts: LoopLagOptions): () => void {
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? 100;
  let expected = now() + intervalMs;
  const timer = setInterval(() => {
    const t = now();
    const lag = t - expected;
    expected = t + intervalMs;
    if (lag > opts.thresholdMs) opts.onLag(lag);
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
