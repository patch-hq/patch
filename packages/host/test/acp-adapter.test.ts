// The ACP adapter's parts (spec/02 § Provider adapters): the JSON-RPC peer,
// the translation of session updates into turn envelopes, session ids, what a
// reattaching host recovers from the runner's files, the MCP servers a session
// gets, and the registry's probe of a real (fake) agent process.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_ACP_AGENTS,
  parseAcpModel,
  providerCapabilities,
  providerForModel,
  providerForSessionId,
  resolveAcpAgents,
} from '@patch/wire';
import { fakeAgent } from './fixtures/acpFake.js';
import { AcpClosedError, AcpConnection, AcpRpcError } from '../src/acpConnection.js';
import { AcpTranslator } from '../src/acpTranslate.js';
import {
  acpMcpServers,
  decodeAcpSessionId,
  encodeAcpSessionId,
  recoverAcpTurn,
} from '../src/acpBackend.js';
import {
  AcpRegistry,
  agentCapabilities,
  declaredCapabilities,
  isAuthError,
  resolveCommand,
  sessionModels,
} from '../src/acpRegistry.js';
import { HARNESS_TRAITS } from '../src/harnesses.js';

describe('the acp provider', () => {
  it('owns acp/ models and acp- sessions, and declares only what ACP guarantees', () => {
    expect(providerForModel('acp/gemini/gemini-2.5-pro')).toBe('acp');
    expect(providerForSessionId('acp-gemini-r-123')).toBe('acp');
    expect(providerCapabilities('acp/gemini/x')).toEqual({
      resume: true,
      editAtMessage: false,
      rewind: false,
      branchAtTurn: false,
      disableNativeTools: false,
      interrupt: true,
      steer: false,
    });
    expect(HARNESS_TRAITS.acp.detachedTurnRunner).toBe(true);
  });

  it('parses agent and model, keeping slashes in the model id', () => {
    expect(parseAcpModel('acp/gemini/models/pro')).toEqual({
      agentId: 'gemini',
      modelId: 'models/pro',
    });
    expect(parseAcpModel('acp/gemini')).toBeUndefined();
    expect(parseAcpModel('openai/gpt')).toBeUndefined();
  });

  it('ships Gemini CLI as data, and an account entry replaces or adds by id', () => {
    expect(BUILTIN_ACP_AGENTS.map((a) => [a.id, a.command, a.args])).toEqual([
      ['gemini', 'gemini', ['--acp']],
    ]);
    const merged = resolveAcpAgents([
      { id: 'gemini', label: 'Mine', command: '/opt/gemini', args: ['--acp'] },
      { id: 'goose', label: 'Goose', command: 'goose', args: ['acp'] },
    ]);
    expect(merged.map((a) => [a.id, a.label])).toEqual([
      ['gemini', 'Mine'],
      ['goose', 'Goose'],
    ]);
  });

  it('declares resume where the agent advertises load or resume', () => {
    expect(declaredCapabilities(agentCapabilities({ protocolVersion: 1 })).resume).toBe(false);
    expect(
      declaredCapabilities(
        agentCapabilities({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
      ).resume,
    ).toBe(true);
    expect(
      agentCapabilities({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      }).resumeSession,
    ).toBe(true);
  });
});

describe('AcpConnection', () => {
  function pair() {
    const sent: any[] = [];
    const notes: Array<[string, unknown]> = [];
    const conn = new AcpConnection((l) => sent.push(JSON.parse(l)), {
      onNotification: (m, p) => notes.push([m, p]),
      onRequest: async (method, params) => {
        if (method === 'boom') throw new AcpRpcError(method, -32601, 'no such thing');
        return { echoed: params };
      },
    });
    return { conn, sent, notes };
  }

  it('matches answers to requests and turns errors into AcpRpcError', async () => {
    const { conn, sent } = pair();
    const a = conn.request('initialize', { x: 1 });
    const b = conn.request('session/new', {});
    expect(sent.map((m) => [m.id, m.method])).toEqual([
      [0, 'initialize'],
      [1, 'session/new'],
    ]);
    conn.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'Authentication required.' },
      }),
    );
    conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 0, result: { ok: true } }));
    await expect(a).resolves.toEqual({ ok: true });
    const err = await b.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcpRpcError);
    expect((err as AcpRpcError).code).toBe(-32000);
    expect(isAuthError(err)).toBe(true);
  });

  it('answers the agent’s requests, and passes notifications on', async () => {
    const { conn, sent, notes } = pair();
    conn.receive(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { a: 1 } }));
    conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 'r1', method: 'ask', params: { q: 1 } }));
    conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 'r2', method: 'boom', params: {} }));
    await new Promise((r) => setTimeout(r, 0));
    expect(notes).toEqual([['session/update', { a: 1 }]]);
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 'r1', result: { echoed: { q: 1 } } });
    expect(sent).toContainEqual({
      jsonrpc: '2.0',
      id: 'r2',
      error: { code: -32601, message: 'no such thing' },
    });
  });

  it('waits on a request a previous host sent, and numbers new ones past it', async () => {
    const sent: any[] = [];
    const conn = new AcpConnection(
      (l) => sent.push(JSON.parse(l)),
      {
        onNotification: () => undefined,
        onRequest: async () => undefined,
      },
      { firstId: 7 },
    );
    const prompt = conn.await(4, 'session/prompt');
    void conn.request('x', {});
    expect(sent[0].id).toBe(7);
    conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 4, result: { stopReason: 'end_turn' } }));
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('fails everything still waiting when the agent goes', async () => {
    const { conn } = pair();
    const p = conn.request('session/prompt', {});
    conn.close('exited (1)');
    await expect(p).rejects.toBeInstanceOf(AcpClosedError);
    await expect(conn.request('x', {})).rejects.toBeInstanceOf(AcpClosedError);
  });
});

describe('AcpTranslator', () => {
  it('streams text, closes it into one message with a stable id, and records thought apart', () => {
    const t = new AcpTranslator('s1:3');
    const out = [
      ...t.push(
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } },
        '10',
      ),
      ...t.push(
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } },
        '20',
      ),
      ...t.push(
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } },
        '30',
      ),
      ...t.flush(),
    ];
    expect(out).toEqual([
      { type: 'system', thinking: 'hm', nativeId: 's1:3:t@10' },
      { type: 'assistant_delta', content: 'Hel' },
      { type: 'assistant_delta', content: 'lo' },
      { type: 'assistant', content: 'Hello', nativeId: 's1:3:m@20' },
    ]);
  });

  it('uses the agent’s message id where it gives one, splitting on a new one', () => {
    const t = new AcpTranslator('k');
    const out = [
      ...t.push(
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'a',
          content: { type: 'text', text: 'one' },
        },
        '1',
      ),
      ...t.push(
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'b',
          content: { type: 'text', text: 'two' },
        },
        '2',
      ),
      ...t.flush(),
    ].filter((e) => e.type === 'assistant');
    expect(out).toEqual([
      { type: 'assistant', content: 'one', nativeId: 'a' },
      { type: 'assistant', content: 'two', nativeId: 'b' },
    ]);
  });

  it('keeps a tool call’s own name and input, and settles it once', () => {
    const t = new AcpTranslator('k');
    const call = t.push(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'Run ls',
        kind: 'execute',
        rawInput: { command: 'ls' },
      },
      '1',
    );
    expect(call).toEqual([
      {
        type: 'tool_use',
        tool: { name: 'Run ls', callId: 'c1', args: { command: 'ls' } },
        nativeId: 'c1',
      },
    ]);
    const done = t.push(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }],
      },
      '2',
    );
    expect(done).toEqual([
      {
        type: 'tool_result',
        toolResult: { name: 'Run ls', callId: 'c1', result: 'a.txt', isError: false },
        nativeId: 'c1:result',
      },
    ]);
    expect(
      t.push({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' }, '3'),
    ).toEqual([]);
    expect(t.unsettledTools()).toEqual([]);
  });

  it('records a diff as the edit it is', () => {
    const t = new AcpTranslator('k');
    t.push({ sessionUpdate: 'tool_call', toolCallId: 'e', title: 'Edit', kind: 'edit' }, '1');
    const [r] = t.push(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'e',
        status: 'completed',
        content: [{ type: 'diff', path: '/a.ts', oldText: 'x', newText: 'y' }],
      },
      '2',
    );
    expect((r as any).toolResult.result).toBe('--- /a.ts\n+++ /a.ts\n-x\n+y');
  });

  it('records a plan as the chat’s task list', () => {
    const t = new AcpTranslator('k');
    const out = t.push(
      {
        sessionUpdate: 'plan',
        entries: [{ content: 'step', priority: 'high', status: 'in_progress' }],
      },
      '9',
    );
    expect(out[0]).toEqual({
      type: 'tool_use',
      tool: {
        name: 'TodoWrite',
        callId: 'k:plan@9',
        args: { todos: [{ content: 'step', status: 'in_progress', priority: 'high' }] },
      },
      nativeId: 'k:plan@9',
    });
    expect(out[1]?.type).toBe('tool_result');
  });

  it('announces a tool call a permission request names before it was announced', () => {
    const t = new AcpTranslator('k');
    const r = t.ensureTool({
      toolCallId: 'p',
      title: 'Delete',
      kind: 'delete',
      rawInput: { path: 'x' },
    });
    expect(r.name).toBe('Delete');
    expect(r.envelopes).toHaveLength(1);
    expect(t.ensureTool({ toolCallId: 'p' }).envelopes).toEqual([]);
  });
});

describe('ACP session ids', () => {
  it('round-trip, hex-encoding ids Patch cannot store as they are', () => {
    const plain = encodeAcpSessionId('gemini', '1b2c-uuid');
    expect(plain).toBe('acp-gemini-r-1b2c-uuid');
    expect(decodeAcpSessionId(plain)).toEqual({ agentId: 'gemini', nativeId: '1b2c-uuid' });
    const odd = encodeAcpSessionId('goose', 'sess/1:2');
    expect(odd).toMatch(/^acp-goose-h-[0-9a-f]+$/);
    expect(decodeAcpSessionId(odd)).toEqual({ agentId: 'goose', nativeId: 'sess/1:2' });
    expect(decodeAcpSessionId('codex-abc')).toBeUndefined();
  });
});

describe('recoverAcpTurn', () => {
  it('finds the session, the prompt, the last request id and an answer given meanwhile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-recover-'));
    const inLines = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 1, method: 'session/new', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'session/set_model', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'S' } },
      { jsonrpc: '2.0', id: 'perm-1', result: { outcome: { outcome: 'cancelled' } } },
    ];
    const outLines = [
      { jsonrpc: '2.0', id: 0, result: { protocolVersion: 1 } },
      { jsonrpc: '2.0', id: 1, result: { sessionId: 'S' } },
      { jsonrpc: '2.0', method: 'session/update', params: {} },
      { jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } },
    ];
    writeFileSync(join(dir, 'in.jsonl'), inLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(join(dir, 'out.jsonl'), outLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const r = recoverAcpTurn(dir);
    expect(r.sessionId).toBe('S');
    expect(r.promptId).toBe(3);
    expect(r.maxRequestId).toBe(3);
    const firstTwo = outLines.slice(0, 2).map((l) => JSON.stringify(l).length + 1);
    expect(r.setupEnd).toBe(firstTwo[0]! + firstTwo[1]!);
    expect(r.promptAnswer).toEqual({ result: { stopReason: 'end_turn' } });
  });
});

describe('acpMcpServers', () => {
  const patch = { command: 'node', args: ['mcp.js'], env: { PATCH_CHAT_ID: 'c' } };
  it('gives the session Patch’s tools and the host’s servers, in ACP’s shape', () => {
    expect(
      acpMcpServers(
        {
          mcpServer: patch,
          extraMcpServers: [
            { name: 'files', command: 'fs', args: [], env: { A: '1' } },
            { name: 'web', url: 'https://x/mcp' },
          ],
        },
        'Fake',
      ),
    ).toEqual([
      {
        name: 'patch',
        command: 'node',
        args: ['mcp.js'],
        env: [{ name: 'PATCH_CHAT_ID', value: 'c' }],
      },
      { name: 'files', command: 'fs', args: [], env: [{ name: 'A', value: '1' }] },
      { type: 'http', name: 'web', url: 'https://x/mcp', headers: [] },
    ]);
  });

  it('leaves switched-off Patch tools out of Patch’s server and refuses any other', () => {
    const [p] = acpMcpServers(
      {
        mcpServer: { ...patch, args: ['mcp.js', '--omit-tools=patch_a'] },
        disabledTools: ['mcp__patch__patch_b'],
      },
      'Fake',
    );
    expect(p!['args']).toEqual(['mcp.js', '--omit-tools=patch_a,patch_b']);
    expect(() => acpMcpServers({ mcpServer: patch, disabledTools: ['Bash'] }, 'Fake')).toThrow(
      /Fake cannot switch off these tools for this chat: Bash/,
    );
  });

  it('gives no servers to a caller that configured none', () => {
    expect(acpMcpServers({}, 'Fake')).toEqual([]);
  });
});

describe('sessionModels', () => {
  const agent = fakeAgent();
  it('reads a model config option, flat or grouped', () => {
    expect(
      sessionModels(agent, {
        sessionId: 's',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'a',
            options: [
              { value: 'a', name: 'Model A' },
              { group: 'g', name: 'G', options: [{ value: 'b', name: 'Model B' }] },
            ],
          } as any,
        ],
      }),
    ).toEqual([
      { id: 'acp/fake/a', label: 'Fake ACP · Model A' },
      { id: 'acp/fake/b', label: 'Fake ACP · Model B' },
    ]);
  });

  it('reads the older models field, and offers the agent’s default when it names none', () => {
    expect(
      sessionModels(agent, {
        sessionId: 's',
        models: { availableModels: [{ modelId: 'm', name: 'M' }], currentModelId: 'm' },
      }),
    ).toEqual([{ id: 'acp/fake/m', label: 'Fake ACP · M' }]);
    expect(sessionModels(agent, { sessionId: 's' })).toEqual([
      { id: 'acp/fake/default', label: 'Fake ACP · default' },
    ]);
  });
});

describe('AcpRegistry', () => {
  function registry(env: Record<string, string> = {}, keys: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'acp-registry-'));
    const state = join(root, 'state');
    mkdirSync(state);
    let changes = 0;
    const reg = new AcpRegistry({
      providerKey: (id) => keys[id],
      baseEnv: () => ({ ...process.env, FAKE_ACP_STATE: state, ...env }),
      scratchDir: join(root, 'scratch'),
      clientVersion: '1.0.0',
      onChange: () => {
        changes += 1;
      },
    });
    return { reg, changes: () => changes };
  }

  it('offers only agents whose command is on this host', () => {
    const { reg } = registry({ PATH: '/nonexistent' });
    reg.setConfigured([fakeAgent(), fakeAgent({ id: 'missing', command: 'no-such-agent-xyz' })]);
    expect(reg.installed().map((a) => a.id)).toEqual(['fake']);
    expect(resolveCommand('sh', '/bin:/usr/bin')).toMatch(/\/sh$/);
    expect(resolveCommand('./sh', '/bin')).toBeUndefined();
  });

  it('asks a running agent for its version, capabilities and models', async () => {
    const { reg, changes } = registry();
    reg.setConfigured([fakeAgent()]);
    const { models, errors } = await reg.models();
    expect(errors).toEqual([]);
    expect(models).toEqual([
      { id: 'acp/fake/fake-pro', label: 'Fake ACP · Fake Pro' },
      { id: 'acp/fake/fake-flash', label: 'Fake ACP · Fake Flash' },
    ]);
    expect(reg.capabilities('fake')).toEqual({
      loadSession: true,
      resumeSession: false,
      image: false,
    });
    expect(reg.backendEntries()).toEqual([
      { id: 'acp:fake', label: 'Fake ACP', version: '9.9.9', state: 'present' },
    ]);
    expect(changes()).toBeGreaterThan(0);
  }, 30_000);

  it('reports an agent that refuses a session for want of its key as signed out, and its key from the shared keys signs it in', async () => {
    const out = registry({ FAKE_ACP_NEED_KEY: '1' });
    out.reg.setConfigured([fakeAgent()]);
    const r = await out.reg.models();
    expect(r.models).toEqual([]);
    expect(r.errors.map((e) => e.message)).toEqual([
      'Fake ACP: not signed in. Add an account for it under Settings → AI accounts, or sign in to it on this host.',
    ]);
    expect(out.reg.accountState('fake')).toEqual({ state: 'signed_out' });
    expect(out.reg.backendEntries()[0]?.state).toBe('logged-out');

    const signedIn = registry({ FAKE_ACP_NEED_KEY: '1' }, { gemini: 'k'.repeat(20) });
    signedIn.reg.setConfigured([fakeAgent()]);
    expect((await signedIn.reg.models()).models).toHaveLength(2);
    expect(signedIn.reg.env(fakeAgent())['FAKE_ACP_KEY']).toBe('k'.repeat(20));
  }, 30_000);

  it('reports an agent that will not start, in its own words', async () => {
    const { reg } = registry();
    reg.setConfigured([
      fakeAgent({ args: ['-e', 'process.stderr.write("bad flag"); process.exit(2)'] }),
    ]);
    const r = await reg.models();
    expect(r.errors[0]?.message).toMatch(
      /^Fake ACP: the agent exited \(2\) before answering \(bad flag\)$/,
    );
  }, 30_000);
});
