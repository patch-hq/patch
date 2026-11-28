// The MCP servers' tools on a voice call (spec/07 § Voice tools), against a real
// MCP server and the real SDK client joined by an in-memory transport.
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpServerConfig, VoiceToolGroup } from '@patch/wire';
import { VoiceToolbox } from '../src/audio/voiceTools.js';
import { VoiceAgentCall } from '../src/audio/voiceAgentCall.js';
import type { VoiceAgentLink } from '../src/audio/voiceAgent.js';
import { elevenSchema, geminiSchema, openaiSchema } from '../src/audio/toolSchemas.js';

const logger = pino({ level: 'silent' });

function homeServer(): McpServer {
  const s = new McpServer({ name: 'home', version: '1.0.0' });
  s.tool('GetState', 'Read an entity', { entity: z.string() }, async ({ entity }) => ({
    content: [{ type: 'text', text: `${entity} is on` }],
  }));
  s.tool('TurnOff', 'Turn something off', { entity: z.string() }, async () => ({
    content: [{ type: 'text', text: 'done' }],
  }));
  return s;
}

function config(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: 'home',
    url: 'http://ha.local/api/mcp',
    enabled: true,
    voice: true,
    voiceOff: [],
    ...over,
  } as McpServerConfig;
}

function setup(initial: McpServerConfig[], groupsOff: VoiceToolGroup[] = []) {
  const state = { servers: initial, groupsOff, server: homeServer() };
  const toolbox = new VoiceToolbox({
    logger,
    servers: () => state.servers,
    groupsOff: () => state.groupsOff,
    secrets: () => undefined,
    connect: async () => {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await state.server.connect(b);
      const client = new Client({ name: 't', version: '1' });
      await client.connect(a);
      return client;
    },
  });
  return { state, toolbox };
}

describe('VoiceToolbox', () => {
  it("lists a server's tools with their schemas, namespaced by server", async () => {
    const { toolbox } = setup([config()]);
    const set = await toolbox.open();
    expect(set.problems).toEqual([]);
    expect(set.specs.map((t) => t.name)).toEqual(['home__GetState', 'home__TurnOff']);
    expect(set.specs[0]!.schema).toMatchObject({
      type: 'object',
      properties: { entity: { type: 'string' } },
    });
    expect(set.resolve('home__GetState')).toEqual({ server: 'home', tool: 'GetState' });
  });

  it('hides tools turned off for the voice, and servers whose voice switch is off', async () => {
    const { toolbox, state } = setup([config({ voiceOff: ['TurnOff'] })]);
    expect((await toolbox.open()).specs.map((t) => t.name)).toEqual(['home__GetState']);
    state.servers = [config({ voice: false })];
    expect((await toolbox.open()).specs).toEqual([]);
  });

  it('a tool the server adds later is on, with nothing ticked', async () => {
    const { toolbox, state } = setup([config({ voiceOff: ['TurnOff'] })]);
    expect((await toolbox.open()).specs).toHaveLength(1);
    state.server.tool('Brightness', 'Set brightness', { level: z.number() }, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    expect((await toolbox.open()).specs.map((t) => t.name)).toContain('home__Brightness');
  });

  it('refuses a tool that was turned off or removed since the call began', async () => {
    const { toolbox, state } = setup([config()]);
    await toolbox.open();
    state.servers = [config({ voiceOff: ['TurnOff'] })];
    await expect(toolbox.call('home', 'TurnOff', {})).rejects.toThrow(/turned off/);
    await expect(toolbox.call('home', 'Gone', {})).rejects.toThrow(/no longer has a tool/);
  });

  it('reports an unreachable server and leaves its tools out', async () => {
    const toolbox = new VoiceToolbox({
      logger,
      servers: () => [config()],
      groupsOff: () => [],
      secrets: () => undefined,
      connect: async () => {
        throw new Error('connection refused');
      },
    });
    const set = await toolbox.open();
    expect(set.specs).toEqual([]);
    expect(set.problems[0]).toMatch(/home tools are not available.*connection refused/);
  });
});

const link = (): VoiceAgentLink => {
  const recorded: Array<{ tool: string; outcome?: unknown }> = [];
  return {
    recordToolCall: (_chat: string, req: { server: string; tool: string }) => {
      const r: { tool: string; outcome?: unknown } = { tool: `mcp__${req.server}__${req.tool}` };
      recorded.push(r);
      return (outcome: unknown) => {
        r.outcome = outcome;
      };
    },
    recorded,
  } as unknown as VoiceAgentLink;
};

describe('a call through MCP', () => {
  it('declares the MCP tools beside the built-ins and returns the result into the call', async () => {
    const { toolbox } = setup([config({ voiceOff: ['TurnOff'] })], ['timers']);
    const l = link();
    const call = new VoiceAgentCall({
      link: l,
      toolbox,
      sessionId: 's',
      chatId: 'c',
      source: { kind: 'voice-app', surfaceKind: 'web', sessionId: 's' },
      logger,
      sendAudio: () => undefined,
    });
    await call.loadTools();
    const names = call
      .tools({ handoff: 'auto', lookBack: true, switchChat: true })
      .map((t) => t.name);
    expect(names).toContain('pass_to_agent');
    expect(names).toContain('home__GetState');
    expect(names).not.toContain('home__TurnOff');
    expect(call.handles('home__GetState')).toBe(true);
    expect(await call.runTool('home__GetState', { entity: 'light.hall' })).toBe('light.hall is on');
    expect((l as unknown as { recorded: unknown[] }).recorded).toEqual([
      { tool: 'mcp__home__GetState', outcome: { result: 'light.hall is on', isError: false } },
    ]);
  });

  it("turns a group of Patch's own tools off for the voice", async () => {
    const { toolbox } = setup([], ['chats']);
    const call = new VoiceAgentCall({
      link: link(),
      toolbox,
      sessionId: 's',
      chatId: 'c',
      source: { kind: 'voice-app', surfaceKind: 'web', sessionId: 's' },
      logger,
      sendAudio: () => undefined,
    });
    await call.loadTools();
    const names = call
      .tools({ handoff: 'auto', lookBack: true, switchChat: true })
      .map((t) => t.name);
    expect(names).not.toContain('find_chats');
    expect(names).not.toContain('send_to_chat');
    expect(names).toContain('end_call');
  });
});

describe('provider schemas', () => {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    properties: {
      entity: { type: 'string' },
      level: { type: ['integer', 'null'], minimum: 0 },
      names: { type: 'array', items: { type: 'string' } },
    },
    required: ['entity'],
  };
  it('gemini: upper-case types, no unions or additionalProperties', () => {
    const g = geminiSchema(schema) as Record<string, any>;
    expect(g.type).toBe('OBJECT');
    expect(g.additionalProperties).toBeUndefined();
    expect(g.properties.level).toMatchObject({ type: 'INTEGER', nullable: true });
    expect(g.properties.names.items.type).toBe('STRING');
  });
  it('openai: as given, minus $schema', () => {
    expect((openaiSchema(schema) as Record<string, unknown>)['$schema']).toBeUndefined();
  });
  it('elevenlabs: every property is described', () => {
    const e = elevenSchema(schema) as Record<string, any>;
    expect(e.properties.entity.description).toBe('entity');
    expect(e.required).toEqual(['entity']);
  });
});
