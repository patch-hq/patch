import { spawn } from 'node:child_process';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

/**
 * Spawn the Claude Code process as the leader of its own process group, and
 * reap the whole group when it goes.
 *
 * The SDK's default spawn signals only the `claude` pid. Everything claude
 * started (MCP servers, `npm exec` wrappers, browsers) is a child of it, and
 * outlives a SIGTERM'd or crashed parent as an orphan under init — which is
 * how finished chats kept ~500MB of processes each. In its own group, one
 * `kill(-pgid)` takes the lot, and the group is swept again once claude has
 * exited, for children that were still running when it went.
 */
export function spawnClaudeInGroup(
  opts: SpawnOptions,
  onRefused?: (message: string) => void,
): SpawnedProcess {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
    windowsHide: true,
  });
  const pgid = child.pid;
  const killGroup = (signal: NodeJS.Signals): boolean => {
    if (pgid === undefined) return child.kill(signal);
    try {
      process.kill(-pgid, signal);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') {
        confirmRefusal(-pgid, signal, REFUSAL_RECHECK_MS, onRefused);
        return true;
      }
      throw e;
    }
  };
  const onAbort = (): void => {
    killGroup('SIGTERM');
  };
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener('abort', onAbort, { once: true });
  child.once('exit', () => {
    opts.signal.removeEventListener('abort', onAbort);
    // Whatever claude left behind is in its group: sweep it.
    killGroup('SIGKILL');
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    kill: killGroup,
    on: child.on.bind(child) as SpawnedProcess['on'],
    once: child.once.bind(child) as SpawnedProcess['once'],
    off: child.off.bind(child) as SpawnedProcess['off'],
  };
}

const REFUSAL_RECHECK_MS = [50, 250, 1000];

/**
 * macOS answers EPERM, not ESRCH, when every process left in the group is
 * already dying: SIGKILL a group, signal it again before the kernel has
 * reaped it, and the second kill is "refused". That is not a refusal, and
 * throwing it took the whole host down mid-turn on every chat end. So an
 * EPERM is signalled again after a pause: ESRCH then means it was the dying
 * group, and an EPERM that persists is a real refusal, which is reported —
 * the group's processes may still be running — rather than swallowed: to the
 * log always, and to `onRefused` (the chat it belongs to) when one is given.
 */
export function confirmRefusal(
  target: number,
  signal: NodeJS.Signals,
  waits: readonly number[] = REFUSAL_RECHECK_MS,
  onRefused?: (message: string) => void,
): void {
  const [wait, ...rest] = waits;
  setTimeout(() => {
    try {
      process.kill(target, signal);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return;
      if (code === 'EPERM' && rest.length > 0) {
        return confirmRefusal(target, signal, rest, onRefused);
      }
      const message = `claude process group ${-target}: ${signal} refused (${code}); its processes may still be running`;
      console.error(message);
      onRefused?.(message);
    }
  }, wait).unref();
}
