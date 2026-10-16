// McpSupervisor: a failed MCP server is reconnected in the background with
// backoff, a tool call waits for a reconnect in flight, and the model is told
// when servers are back.

import { describe, expect, it } from 'vitest';
import { McpSupervisor, restoredNotice, supervisorHooks } from '../src/mcpSupervisor.js';

function fakeQuery(failTimes: number) {
  let failed = true;
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = { hold: false };
  return {
    get calls() {
      return calls;
    },
    release: () => release?.(),
    gate,
    mcpServerStatus: async () => [
      { name: 'patch', status: 'connected' },
      { name: 'playwright', status: failed ? 'failed' : 'connected', error: 'CONNECT_TIMEOUT' },
    ],
    reconnectMcpServer: async () => {
      calls++;
      if (gate.hold) await new Promise<void>((r) => (release = r));
      if (calls <= failTimes) throw new Error('timeout');
      failed = false;
    },
  };
}

const quiet = { log: () => undefined, sleep: async () => undefined };

describe('McpSupervisor', () => {
  it('retries a failed server with doubling backoff until it connects, then reports it restored', async () => {
    const q = fakeQuery(2);
    const sup = new McpSupervisor({
      query: q,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      pollMs: 5,
      ...quiet,
    });
    for (let i = 0; i < 20 && q.calls < 3; i++) {
      await sup.tick();
      (sup as unknown as { clock: number }).clock += 5;
    }
    expect(q.calls).toBe(3);
    expect(sup.takeRestored()).toEqual(['playwright']);
    expect(sup.takeRestored()).toEqual([]);
    await sup.tick();
    expect(q.calls).toBe(3);
  });

  it('does not retry before the backoff has elapsed', async () => {
    const q = fakeQuery(5);
    const sup = new McpSupervisor({ query: q, baseDelayMs: 1000, pollMs: 5, ...quiet });
    await sup.tick();
    await sup.tick();
    expect(q.calls).toBe(1);
  });

  it('makes an MCP tool call wait for the in-flight reconnect, then announces it', async () => {
    const q = fakeQuery(0);
    q.gate.hold = true;
    const sup = new McpSupervisor({
      query: q,
      pollMs: 5,
      ...quiet,
      sleep: () => new Promise(() => undefined),
    });
    const ticking = sup.tick();
    await Promise.resolve();
    await Promise.resolve();
    const hooks = supervisorHooks(sup);
    let done = false;
    const call = (
      hooks.PreToolUse[0]!.hooks[0] as (i: unknown, ...a: unknown[]) => Promise<unknown>
    )({
      tool_name: 'mcp__playwright__browser_navigate',
    }).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    q.release();
    await ticking;
    await call;
    expect(done).toBe(true);
    const out = (await (
      hooks.PostToolBatch[0]!.hooks[0] as (...a: unknown[]) => Promise<unknown>
    )()) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(out.hookSpecificOutput.additionalContext).toBe(restoredNotice(['playwright']));
  });

  it('survives a failing status read', async () => {
    const sup = new McpSupervisor({
      query: {
        mcpServerStatus: async () => Promise.reject(new Error('x')),
        reconnectMcpServer: async () => undefined,
      },
      ...quiet,
    });
    await expect(sup.tick()).resolves.toBeUndefined();
  });
});
