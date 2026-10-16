// How a detached deploy is launched.
//
// The deploy's last step restarts patch-daemon.service. A process started from
// a chat on the box lives in that service's cgroup, and `detached: true` only
// leaves the terminal and process group, not the cgroup — so the restart killed
// the deploy before it could verify or notify (2026-09-17, and again whenever
// the apply step ran). Launching through `systemd-run --scope` puts the deploy
// in a cgroup of its own, which a service restart does not touch.

/**
 * @param {string} execPath node binary
 * @param {string[]} args arguments to it
 * @param {{ systemdRun: boolean }} env whether `systemd-run --user` is usable here
 * @returns {{ cmd: string, args: string[], scoped: boolean }}
 */
export function detachCommand(execPath, args, env) {
  if (!env.systemdRun) return { cmd: execPath, args, scoped: false };
  return {
    cmd: 'systemd-run',
    args: ['--user', '--scope', '--quiet', '--collect', execPath, ...args],
    scoped: true,
  };
}
