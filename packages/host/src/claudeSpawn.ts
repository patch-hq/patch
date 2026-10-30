import { spawn } from 'node:child_process';
import { existsSync, lstatSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { newTurnTag, TURN_TAG_ENV, killTagged } from './turnTag.js';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

/** What a resumed chat needs from the user's own Claude config dir. */
const USER_CONFIG_ENTRIES = [
  'skills',
  'agents',
  'commands',
  'plugins',
  'settings.json',
  'CLAUDE.md',
];

/**
 * A chat resumed from the session store runs under a throwaway
 * `CLAUDE_CONFIG_DIR` (`/tmp/claude-resume-<id>`) the SDK fills with only the
 * transcript and credentials — so none of the user's own skills, agents,
 * commands or settings load. Link them in from the real config dir. A no-op
 * for any other config dir. Throws on a failed link: a resumed chat silently
 * missing its skills is the bug this exists to prevent.
 */
export function linkUserConfigIntoResumeDir(
  env: SpawnOptions['env'],
  realDir: string = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'),
): void {
  const dir = env['CLAUDE_CONFIG_DIR'];
  if (dir === undefined || !basename(dir).startsWith('claude-resume-') || dir === realDir) return;
  for (const name of USER_CONFIG_ENTRIES) {
    const src = join(realDir, name);
    const dest = join(dir, name);
    if (!existsSync(src)) continue;
    try {
      lstatSync(dest);
      continue; // already there
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    symlinkSync(src, dest);
  }
}

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
  onPid?: (pid: number | undefined) => void,
): SpawnedProcess {
  linkUserConfigIntoResumeDir(opts.env);
  const turnTag = newTurnTag();
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...opts.env, [TURN_TAG_ENV]: turnTag },
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
    windowsHide: true,
  });
  const pgid = child.pid;
  onPid?.(pgid);
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
    killTagged(turnTag);
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
