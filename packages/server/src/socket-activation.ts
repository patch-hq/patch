// A listening socket handed over by systemd (socket activation).
//
// The installer's patch-server.socket unit owns the port, so restarting the
// service for a release never closes it: connections that arrive while the old
// process is stopping and the new one is starting wait in the kernel's queue and
// are accepted by the new process, instead of being refused (a 502 at the
// proxy). systemd passes the socket as file descriptor 3 and says so in
// LISTEN_PID / LISTEN_FDS (sd_listen_fds(3)).

/** First descriptor systemd passes (SD_LISTEN_FDS_START). */
export const LISTEN_FDS_START = 3;

/**
 * The descriptor to listen on, or undefined when this process was not started
 * by a socket unit. A LISTEN_PID that is not ours means the variables were
 * inherited from a parent — not ours to use.
 */
export function activatedFd(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): number | undefined {
  if (env.LISTEN_PID === undefined && env.LISTEN_FDS === undefined) return undefined;
  if (env.LISTEN_PID !== String(pid)) return undefined;
  const n = Number(env.LISTEN_FDS);
  if (n !== 1) {
    throw new Error(
      `socket activation passed ${env.LISTEN_FDS} sockets; patch-server takes exactly one`,
    );
  }
  return LISTEN_FDS_START;
}
