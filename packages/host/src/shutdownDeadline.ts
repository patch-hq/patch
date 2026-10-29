// Graceful shutdown with a hard deadline.
//
// A self-update's installer re-registers the service, and `launchctl bootout`
// waits for THIS process to exit before it returns. If any step of the
// graceful shutdown hangs (a socket that never closes, a request the HTTP
// server is still draining), the installer stalls on that bootout, hits its
// own timeout and is killed before it bootstraps the new job — leaving the
// host with no service loaded at all (2026-10-17: host 1.1.39 → 1.1.52
// logged "shutting down", kept running, and the Mac sat offline until a
// manual `launchctl bootstrap`). So shutdown gets a fixed budget, after which
// the process exits regardless.

/** How long graceful shutdown may take before the process exits anyway. */
export const SHUTDOWN_DEADLINE_MS = 10_000;

export function shutdownThenExit(
  shutdown: () => Promise<void>,
  opts: {
    exit: (code: number) => void;
    onDeadline: () => void;
    deadlineMs?: number;
  },
): void {
  const timer = setTimeout(() => {
    opts.onDeadline();
    opts.exit(0);
  }, opts.deadlineMs ?? SHUTDOWN_DEADLINE_MS);
  timer.unref();
  void shutdown().then(
    () => {
      clearTimeout(timer);
      opts.exit(0);
    },
    () => {
      clearTimeout(timer);
      opts.exit(1);
    },
  );
}
