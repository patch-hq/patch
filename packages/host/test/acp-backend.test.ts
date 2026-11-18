// The ACP adapter (spec/02 § Provider adapters) against an in-process ACP agent
// speaking the real protocol through the official SDK. No external agent or
// paid API is involved.

import { describe, expect, it } from 'vitest';
import { agent, methods, type AgentApp } from '@agentclientprotocol/sdk';
import { AcpBackend } from '../src/acpBackend.js';
import type { SdkEnvelope, SdkRunOptions } from '../src/sdkBackend.js';

interface Seen {
  prompts: unknown[];
  loaded: string[];
  newCwd: string[];
  mcp: unknown[];
  cancelled: number;
  permissionOutcomes: unknown[];
}

function mockAgent(
  seen: Seen,
  o: {
    loadSession?: boolean;
    script: (
      send: (u: Record<string, unknown>) => Promise<void>,
      ask: (opts: unknown[], kind: string) => Promise<unknown>,
    ) => Promise<string>;
  },
): AgentApp {
  return agent({ name: 'mock' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: o.loadSession ?? true },
    }))
    .onRequest(methods.agent.session.new, ({ params }) => {
      seen.newCwd.push(params.cwd);
      seen.mcp.push(params.mcpServers);
      return { sessionId: 'sess-1' };
    })
    .onRequest(methods.agent.session.load, async ({ params, client }) => {
      seen.loaded.push(params.sessionId);
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD' } },
      });
      return {};
    })
    .onNotification(methods.agent.session.cancel, () => {
      seen.cancelled++;
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      seen.prompts.push(params.prompt);
      const send = (update: Record<string, unknown>) =>
        client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: update as never,
        });
      const ask = async (options: unknown[], kind: string) => {
        const r = await client.request(methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 't1', title: 'Edit file', kind: kind as never },
          options: options as never,
        });
        seen.permissionOutcomes.push(r.outcome);
        return r.outcome;
      };
      return { stopReason: (await o.script(send, ask)) as never };
    });
}

const newSeen = (): Seen => ({
  prompts: [],
  loaded: [],
  newCwd: [],
  mcp: [],
  cancelled: 0,
  permissionOutcomes: [],
});

function backend(app: AgentApp): AcpBackend {
  return new AcpBackend({
    sessionPrefix: 'gemini-',
    resolveAgent: () => {
      throw new Error('not used: tests connect in-process');
    },
    connect: () => ({ target: app, close: () => undefined }),
  });
}

function opts(extra: Partial<SdkRunOptions> = {}): SdkRunOptions {
  return {
    prompt: 'hello',
    cwd: '/work',
    abortController: new AbortController(),
    oauthAccessToken: '',
    permissionMode: 'default',
    ...extra,
  };
}

async function collect(it: AsyncIterable<SdkEnvelope>): Promise<SdkEnvelope[]> {
  const out: SdkEnvelope[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const ALLOW = [
  { optionId: 'a1', name: 'Allow', kind: 'allow_once' },
  { optionId: 'a2', name: 'Always', kind: 'allow_always' },
  { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
];

describe('ACP adapter', () => {
  it('runs a turn: session id, streamed text, tool call and result, final message', async () => {
    const seen = newSeen();
    const app = mockAgent(seen, {
      script: async (send) => {
        await send({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hi ' },
        });
        await send({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'there' },
        });
        await send({
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'ls',
          rawInput: { dir: '.' },
        });
        await send({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'c1',
          status: 'completed',
          rawOutput: 'a b',
        });
        return 'end_turn';
      },
    });
    const events = await collect(backend(app).run(opts()));
    expect(events[0]).toEqual({ type: 'system', sessionId: 'gemini-sess-1' });
    expect(events.filter((e) => e.type === 'assistant_delta').map((e) => e.content)).toEqual([
      'Hi ',
      'there',
    ]);
    const kinds = events.map((e) => e.type);
    expect(kinds.indexOf('assistant')).toBeLessThan(kinds.indexOf('tool_use'));
    expect(events.find((e) => e.type === 'assistant')?.content).toBe('Hi there');
    expect(events.find((e) => e.type === 'tool_use')?.tool).toEqual({
      name: 'ls',
      callId: 'c1',
      args: { dir: '.' },
    });
    expect(events.find((e) => e.type === 'tool_result')?.toolResult).toMatchObject({
      callId: 'c1',
      result: 'a b',
      isError: false,
    });
    expect(events.at(-1)).toEqual({ type: 'result', sessionId: 'gemini-sess-1' });
    expect(seen.newCwd).toEqual(['/work']);
    expect(seen.prompts[0]).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('resumes with session/load and drops the replayed history', async () => {
    const seen = newSeen();
    const app = mockAgent(seen, {
      script: async (send) => {
        await send({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'NEW' },
        });
        return 'end_turn';
      },
    });
    const events = await collect(backend(app).run(opts({ resumeSessionId: 'gemini-sess-9' })));
    expect(seen.loaded).toEqual(['sess-9']);
    expect(seen.newCwd).toEqual([]);
    expect(events.filter((e) => e.type === 'assistant').map((e) => e.content)).toEqual(['NEW']);
  });

  it('refuses to resume when the agent cannot load sessions', async () => {
    const app = mockAgent(newSeen(), { loadSession: false, script: async () => 'end_turn' });
    await expect(
      collect(backend(app).run(opts({ resumeSessionId: 'gemini-sess-9' }))),
    ).rejects.toThrow(/cannot resume/);
  });

  it("refuses another harness's session and auto permissions", async () => {
    const app = mockAgent(newSeen(), { script: async () => 'end_turn' });
    await expect(collect(backend(app).run(opts({ resumeSessionId: 'codex-1' })))).rejects.toThrow(
      /Another harness/,
    );
    await expect(collect(backend(app).run(opts({ permissionMode: 'auto' })))).rejects.toThrow(
      /auto permissions/,
    );
  });

  it('asks the user in default mode and maps approve and deny to the agent options', async () => {
    for (const [approve, optionId] of [
      [true, 'a1'],
      [false, 'r1'],
    ] as const) {
      const seen = newSeen();
      const app = mockAgent(seen, {
        script: async (_s, ask) => {
          await ask(ALLOW, 'execute');
          return 'end_turn';
        },
      });
      const asked: string[] = [];
      await collect(
        backend(app).run(
          opts({
            onPermissionRequest: async (r) => {
              asked.push(r.tool);
              return { approve };
            },
          }),
        ),
      );
      expect(asked).toEqual(['Edit file']);
      expect(seen.permissionOutcomes).toEqual([{ outcome: 'selected', optionId }]);
    }
  });

  it('answers permissions by mode without asking: bypass allows, plan rejects, acceptEdits allows edits only', async () => {
    const run = async (mode: SdkRunOptions['permissionMode'], kind: string) => {
      const seen = newSeen();
      const app = mockAgent(seen, {
        script: async (_s, ask) => {
          await ask(ALLOW, kind);
          return 'end_turn';
        },
      });
      await collect(
        backend(app).run(
          opts({
            permissionMode: mode,
            onPermissionRequest: async () => ({ approve: false }),
          }),
        ),
      );
      return seen.permissionOutcomes[0];
    };
    expect(await run('bypassPermissions', 'execute')).toEqual({
      outcome: 'selected',
      optionId: 'a1',
    });
    expect(await run('plan', 'edit')).toEqual({ outcome: 'selected', optionId: 'r1' });
    expect(await run('acceptEdits', 'edit')).toEqual({ outcome: 'selected', optionId: 'a1' });
    // acceptEdits on a non-edit goes to the user, who said no.
    expect(await run('acceptEdits', 'execute')).toEqual({ outcome: 'selected', optionId: 'r1' });
  });

  it('interrupt cancels the prompt and the turn ends as interrupted', async () => {
    const seen = newSeen();
    let release!: () => void;
    const app = mockAgent(seen, {
      script: async () => {
        await new Promise<void>((r) => (release = r));
        return 'cancelled';
      },
    });
    const ac = new AbortController();
    const done = collect(backend(app).run(opts({ abortController: ac }))).catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await new Promise((r) => setTimeout(r, 50));
    release();
    const result = await done;
    expect(seen.cancelled).toBe(1);
    expect((result as Error).message).toBe('Turn interrupted');
  });

  it('a refusal or early stop is an error, not a result', async () => {
    for (const reason of ['refusal', 'max_tokens']) {
      const app = mockAgent(newSeen(), { script: async () => reason });
      await expect(collect(backend(app).run(opts()))).rejects.toThrow();
    }
  });

  it('hands the Patch tools server to the agent as a stdio MCP server', async () => {
    const seen = newSeen();
    const app = mockAgent(seen, { script: async () => 'end_turn' });
    await collect(
      backend(app).run(
        opts({ mcpServer: { command: 'node', args: ['mcp.js'], env: { TOKEN: 'x' } } }),
      ),
    );
    expect(seen.mcp[0]).toEqual([
      { name: 'patch', command: 'node', args: ['mcp.js'], env: [{ name: 'TOKEN', value: 'x' }] },
    ]);
  });
});

describe('ACP model list', () => {
  const modelAgent = (extra: Record<string, unknown>): AgentApp =>
    agent({ name: 'mock' })
      .onRequest(methods.agent.initialize, () => ({ protocolVersion: 1 }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: 's', ...extra }) as never);

  it('reads the models from the agent’s model selector', async () => {
    const app = modelAgent({
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'a',
          options: [
            { value: 'a', name: 'A' },
            { group: 'g', name: 'G', options: [{ value: 'b', name: 'B' }] },
          ],
        },
      ],
    });
    expect(await backend(app).models('/x')).toEqual([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ]);
  });

  it('reads the older models state', async () => {
    const app = modelAgent({ models: { availableModels: [{ modelId: 'm', name: 'M' }] } });
    expect(await backend(app).models('/x')).toEqual([{ id: 'm', label: 'M' }]);
  });

  it('an agent with no model list is an error, not an empty list', async () => {
    await expect(backend(modelAgent({})).models('/x')).rejects.toThrow(/no model list/);
  });
});
