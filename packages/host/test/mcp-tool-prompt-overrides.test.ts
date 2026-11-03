// Tool prompt overrides (spec/06 § Tool prompts): an edit of a Patch tool's
// description reaches the model through the MCP child's tool list.

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  buildPatchToolsServer,
  parseToolPromptOverrides,
  patchToolDescriptions,
} from '../src/mcp.js';

async function listTools(toolPromptOverrides?: Record<string, string>) {
  const server = buildPatchToolsServer({
    hostSocketPath: '/dev/null',
    chatId: 'test-chat',
    localKey: 'test-key',
    ...(toolPromptOverrides ? { toolPromptOverrides } : {}),
  });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(c), server.connect(s)]);
  return (await client.listTools()).tools;
}

describe('tool prompt overrides', () => {
  it('replaces only the named tool description', async () => {
    const before = await listTools();
    const after = await listTools({ patch_peek: 'Edited peek.' });
    const desc = (tools: typeof before, n: string) => tools.find((t) => t.name === n)?.description;
    expect(desc(after, 'patch_peek')).toBe('Edited peek.');
    expect(desc(after, 'patch_history')).toBe(desc(before, 'patch_history'));
  });

  it('applies to the browser tools that are gated until patch_browser_open', async () => {
    const server = buildPatchToolsServer({
      hostSocketPath: '/dev/null',
      chatId: 'c',
      localKey: 'k',
      toolPromptOverrides: { patch_browser_open: 'Edited open.' },
    });
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([client.connect(c), server.connect(s)]);
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === 'patch_browser_open')?.description).toBe('Edited open.');
  });

  it('exposes every built-in description by tool name', () => {
    const defaults = patchToolDescriptions();
    expect(defaults['patch_peek']).toContain('chat');
    expect(Object.values(defaults).every((d) => d.length > 0)).toBe(true);
  });

  it('parses the launch env and refuses a malformed one', () => {
    expect(parseToolPromptOverrides(undefined)).toEqual({});
    expect(parseToolPromptOverrides('{"a":"b"}')).toEqual({ a: 'b' });
    expect(() => parseToolPromptOverrides('[]')).toThrow(/NO FALLBACK/);
    expect(() => parseToolPromptOverrides('{"a":1}')).toThrow(/NO FALLBACK/);
    expect(() => parseToolPromptOverrides('{nope')).toThrow();
  });
});
