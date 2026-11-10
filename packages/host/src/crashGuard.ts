// A write to a child process that has already died (an agent SDK subprocess
// killed under memory pressure) raises EPIPE as an unhandled 'error' event,
// which Node turns into a process crash. That took the whole host down, and
// every chat with it, whenever the host stalled. EPIPE on a write is one
// dead child, not a dead host: log it loudly and carry on. Everything else
// still logs fatally and exits, as before.
interface GuardLogger {
  error(obj: object, msg: string): void;
  fatal(obj: object, msg: string): void;
}

export function handleUncaught(
  err: unknown,
  logger: GuardLogger,
  exit: (code: number) => void,
): void {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === 'EPIPE' && e.syscall === 'write') {
    logger.error({ err }, 'uncaught EPIPE writing to a dead child process; host kept alive');
    return;
  }
  if (e instanceof Error && e.message === 'Cannot write to terminated process') {
    // The agent SDK's transport throws this when a write races a child that has
    // already exited. Same dead child as EPIPE, not a dead host.
    logger.error({ err }, 'uncaught write to a terminated child process; host kept alive');
    return;
  }
  logger.fatal({ err }, 'uncaught exception; exiting');
  exit(1);
}

export function installCrashGuard(logger: GuardLogger): void {
  process.on('uncaughtException', (err) => handleUncaught(err, logger, (c) => process.exit(c)));
}
