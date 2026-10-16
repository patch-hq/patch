// Keeps a chat's MCP servers connected. The Claude process connects them once
// at start with a timeout; a server that misses it (heavy load, a slow `npx`)
// or drops later stays gone for the rest of the session. This watches the
// process's own view of them (`mcpServerStatus`), reconnects a failed one in
// the background with backoff (`reconnectMcpServer`), lets a tool call wait for
// a reconnect in flight, and reports which servers came back so the model can
// be told its tools are available again.

import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

/** First-start allowance for an MCP server, in ms (Claude Code's default is 30s). */
export const MCP_START_TIMEOUT_MS = 120_000;

export interface McpStatusSource {
  mcpServerStatus(): Promise<{ name: string; status: string; error?: string }[]>;
  reconnectMcpServer(name: string): Promise<void>;
}

export interface McpSupervisorOptions {
  /** Omit when the query is built after its hooks; call `bind` once it exists. */
  query?: McpStatusSource;
  /** Backoff between attempts per server: first, then doubling up to max. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** How often the status is re-read while everything looks fine. */
  pollMs?: number;
  /** Longest a tool call waits for an in-flight reconnect. */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class McpSupervisor {
  private q: McpStatusSource | undefined;
  private readonly base: number;
  private readonly max: number;
  private readonly poll: number;
  private readonly waitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private stopped = false;
  private readonly attempts = new Map<string, number>();
  private readonly nextTry = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<boolean>>();
  private readonly down = new Set<string>();
  private readonly restored = new Set<string>();
  private clock = 0;

  constructor(opts: McpSupervisorOptions) {
    this.q = opts.query;
    this.base = opts.baseDelayMs ?? 2_000;
    this.max = opts.maxDelayMs ?? 60_000;
    this.poll = opts.pollMs ?? 5_000;
    this.waitMs = opts.waitMs ?? 90_000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.log = opts.log ?? ((l) => console.warn(l));
  }

  /** Attach the query and start watching it in the background until `stop()`. */
  bind(query: McpStatusSource): void {
    this.q = query;
    void this.run();
  }

  /** Run until `stop()`. Never throws: a status read that fails is logged and retried. */
  async run(): Promise<void> {
    while (!this.stopped) {
      await this.tick();
      await this.sleep(this.poll);
      this.clock += this.poll;
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** One pass: read status, start a reconnect for each failed server whose backoff has elapsed. */
  async tick(): Promise<void> {
    if (!this.q) return;
    let statuses;
    try {
      statuses = await this.q.mcpServerStatus();
    } catch (err) {
      this.log(`mcp supervisor: status read failed: ${String(err)}`);
      return;
    }
    const pending: Promise<boolean>[] = [];
    for (const s of statuses) {
      if (s.status === 'connected') {
        this.attempts.delete(s.name);
        this.nextTry.delete(s.name);
        if (this.down.delete(s.name)) this.restored.add(s.name);
      } else if (s.status === 'failed') {
        this.down.add(s.name);
        if (!this.inflight.has(s.name) && (this.nextTry.get(s.name) ?? 0) <= this.clock) {
          pending.push(this.reconnect(s.name, s.error));
        }
      }
    }
    await Promise.all(pending);
  }

  private reconnect(name: string, error: string | undefined): Promise<boolean> {
    const n = (this.attempts.get(name) ?? 0) + 1;
    this.attempts.set(name, n);
    this.log(
      `mcp supervisor: reconnecting ${name} (attempt ${n}${error ? `, was: ${error}` : ''})`,
    );
    const p = this.q!.reconnectMcpServer(name)
      .then(() => {
        this.down.delete(name);
        this.restored.add(name);
        this.attempts.delete(name);
        this.nextTry.delete(name);
        return true;
      })
      .catch((err: unknown) => {
        const delay = Math.min(this.max, this.base * 2 ** (n - 1));
        this.nextTry.set(name, this.clock + delay);
        this.log(`mcp supervisor: ${name} still down: ${String(err)}; retry in ${delay}ms`);
        return false;
      })
      .finally(() => this.inflight.delete(name));
    this.inflight.set(name, p);
    return p;
  }

  /** Resolves once any reconnect in flight for `name` has settled (bounded). True if connected. */
  async waitFor(name: string): Promise<boolean> {
    const p = this.inflight.get(name);
    if (!p) return !this.down.has(name);
    const timeout = this.sleep(this.waitMs).then(() => false);
    return Promise.race([p, timeout]);
  }

  /** Servers that came back since the last call; clears the list. */
  takeRestored(): string[] {
    const names = [...this.restored];
    this.restored.clear();
    return names;
  }
}

export function restoredNotice(names: readonly string[]): string {
  return `MCP server${names.length > 1 ? 's' : ''} ${names.join(', ')} failed to start earlier and ${names.length > 1 ? 'are' : 'is'} now connected: the tools ${names.length > 1 ? 'are' : 'is'} available again.`;
}

/** Hooks: a call to an MCP tool waits for its server's reconnect; restored servers are announced at the next tool boundary. */
export function supervisorHooks(sup: McpSupervisor): {
  PreToolUse: HookCallbackMatcher[];
  PostToolBatch: HookCallbackMatcher[];
} {
  return {
    PreToolUse: [
      {
        matcher: '^mcp__',
        hooks: [
          async (input) => {
            const tool = (input as { tool_name?: string }).tool_name ?? '';
            const server = tool.split('__')[1];
            if (server) await sup.waitFor(server);
            return {};
          },
        ],
      },
    ],
    PostToolBatch: [
      {
        hooks: [
          async () => {
            const names = sup.takeRestored();
            if (names.length === 0) return {};
            return {
              hookSpecificOutput: {
                hookEventName: 'PostToolBatch',
                additionalContext: restoredNotice(names),
              },
            };
          },
        ],
      },
    ],
  };
}
