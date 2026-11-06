/**
 * Runs agent work in its own systemd slice when the host asks for it.
 *
 * Everything a chat starts (tests, builds, browsers) would otherwise share the
 * host's cgroup, and a resource limit cannot favour the host over work inside
 * its own group. With `PATCH_WORK_SLICE` set, the OS can squeeze the work and
 * leave the host responsive. Unset, commands run exactly as given.
 *
 * `systemd-run --scope` execs the command in place: the pid, process group,
 * stdio and environment are the ones the caller set up. If it cannot start the
 * scope it exits non-zero and the launch fails visibly; there is no retry
 * outside the slice, because that would silently remove the protection.
 */
export function inWorkSlice(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const slice = env['PATCH_WORK_SLICE'];
  if (!slice) return { command, args: [...args] };
  return {
    command: 'systemd-run',
    args: ['--user', '--scope', '--quiet', '--collect', `--slice=${slice}`, '--', command, ...args],
  };
}
