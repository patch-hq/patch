// A tool call that never returns leaves its turn running with nothing on
// screen. Claude Code's own timeout is meant to end a Bash call, but a process
// blocked inside the kernel (macOS privacy checks on ~/Documents wait on a
// prompt nobody sees) ignores it, and the turn stalls until the user types.
// This ends such a turn from the host side, with an error that names the tool
// and, on a Mac, the permission that is probably missing.

import { homedir } from 'node:os';
import { TurnFailedError } from './sdkBackend.js';
import type { SdkEnvelope } from './sdkBackend.js';

/** Claude Code's default Bash timeout, and its ceiling. */
const BASH_DEFAULT_MS = 120_000;
const BASH_MAX_MS = 600_000;
/** How long past its own timeout a tool may take before the host gives up on it. */
export const TOOL_HUNG_GRACE_MS = 30_000;
/** Ceiling for tools that carry no timeout of their own. */
const FILE_TOOL_MS = 120_000;
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']);

/** Folders macOS guards behind a privacy prompt. */
const PROTECTED = ['Documents', 'Desktop', 'Downloads'];

export class ToolHungError extends TurnFailedError {
  readonly tool: string;
  readonly waitedMs: number;
  constructor(tool: string, waitedMs: number, message: string) {
    super(message, undefined);
    this.name = 'ToolHungError';
    this.tool = tool;
    this.waitedMs = waitedMs;
  }
}

/**
 * How long `tool` may run before it counts as hung, or undefined when the host
 * does not police it (subagents, MCP tools, background commands and questions
 * legitimately run long).
 */
export function toolDeadlineMs(tool: string, args: unknown): number | undefined {
  const a = (args ?? {}) as Record<string, unknown>;
  if (tool === 'Bash') {
    if (a['run_in_background'] === true) return undefined;
    const t = typeof a['timeout'] === 'number' && a['timeout'] > 0 ? a['timeout'] : BASH_DEFAULT_MS;
    return Math.min(t, BASH_MAX_MS) + TOOL_HUNG_GRACE_MS;
  }
  if (FILE_TOOLS.has(tool)) return FILE_TOOL_MS + TOOL_HUNG_GRACE_MS;
  return undefined;
}

/** The macOS-guarded folder a call touches, if it does. */
export function protectedFolderIn(args: unknown, home: string = homedir()): string | undefined {
  const text = JSON.stringify(args ?? {});
  for (const name of PROTECTED) {
    if (text.includes(`${home}/${name}`) || text.includes(`~/${name}`)) return name;
  }
  return undefined;
}

export function hungMessage(
  tool: string,
  waitedMs: number,
  args: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  const secs = Math.round(waitedMs / 1000);
  const base = `The ${tool} call did not return after ${secs}s, so the host stopped waiting.`;
  const folder = platform === 'darwin' ? protectedFolderIn(args) : undefined;
  if (folder === undefined) return base;
  return `${base} It touched ~/${folder}, which macOS guards: grant the Patch host Full Disk Access (System Settings > Privacy & Security > Full Disk Access), or accept a pending prompt on the Mac.`;
}

export interface ToolWatchdogOptions {
  /** True while the turn is waiting on the user (a permission card); the clock stops then. */
  paused?: () => boolean;
  now?: () => number;
  /** How often in-flight calls are checked. */
  pollMs?: number;
  platform?: NodeJS.Platform;
}

const HUNG = Symbol('tool-hung');

/** Pass `source` through, failing it with {@link ToolHungError} when a policed tool call outlives its deadline. */
export async function* withToolWatchdog(
  source: AsyncIterable<SdkEnvelope>,
  opts: ToolWatchdogOptions = {},
): AsyncGenerator<SdkEnvelope> {
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 5_000;
  const inFlight = new Map<string, { tool: string; args: unknown; since: number; limit: number }>();
  const it = source[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setInterval> | undefined;
  let trip: ToolHungError | undefined;
  let wake: (() => void) | undefined;
  const hung = new Promise<typeof HUNG>((resolve) => {
    wake = () => resolve(HUNG);
  });
  const check = (): void => {
    const t = now();
    if (opts.paused?.()) {
      for (const c of inFlight.values()) c.since = t;
      return;
    }
    for (const c of inFlight.values()) {
      if (t - c.since < c.limit) continue;
      trip = new ToolHungError(
        c.tool,
        t - c.since,
        hungMessage(c.tool, t - c.since, c.args, opts.platform),
      );
      wake?.();
      return;
    }
  };
  try {
    timer = setInterval(check, pollMs);
    timer.unref?.();
    for (;;) {
      const pending = it.next();
      pending.catch(() => undefined);
      const r = await Promise.race([pending, hung]);
      if (r === HUNG) {
        void Promise.resolve(it.return?.()).catch(() => undefined);
        throw trip!;
      }
      if (r.done === true) return;
      const env = r.value;
      if (env.type === 'tool_use' && env.tool) {
        const limit = toolDeadlineMs(env.tool.name, env.tool.args);
        if (limit !== undefined) {
          inFlight.set(env.tool.callId, {
            tool: env.tool.name,
            args: env.tool.args,
            since: now(),
            limit,
          });
        }
      } else if (env.type === 'tool_result' && env.toolResult) {
        inFlight.delete(env.toolResult.callId);
      }
      yield env;
    }
  } finally {
    if (timer !== undefined) clearInterval(timer);
  }
}
