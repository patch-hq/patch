// One tool per job (principles.md § Patch-owned state): where a provider cannot
// switch a native tool off, the Patch tool that duplicates it is withheld from
// that provider's chats; a Patch tool with no native twin stays.

import { it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { patchToolsOmittedFor } from '@patch/wire';
import { buildPatchToolsServer, parseOmitToolsArg } from '../src/mcp.js';

async function toolNames(omitTools: readonly string[]): Promise<string[]> {
  const server = buildPatchToolsServer({
    hostSocketPath: '/nonexistent.sock',
    chatId: 'c1',
    localKey: 'k',
    omitTools,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return ((await client.listTools()).tools as { name: string }[]).map((t) => t.name);
}

it('Codex keeps its native subagents, so patch_agent goes; wakes, loops and goals stay', async () => {
  const omitted = patchToolsOmittedFor('openai/gpt-5');
  expect(omitted).toEqual(['patch_agent']);
  const names = await toolNames(omitted);
  expect(names).not.toContain('patch_agent');
  for (const n of [
    'patch_wake_me',
    'patch_loop',
    'patch_goal_set',
    'patch_goal_get',
    'patch_goal_clear',
  ]) {
    expect(names).toContain(n);
  }
});

it('Claude can switch its native tools off, so every Patch tool is offered', async () => {
  expect(patchToolsOmittedFor('claude-opus-5')).toEqual([]);
  const names = await toolNames([]);
  for (const n of ['patch_agent', 'patch_wake_me', 'patch_goal_set']) expect(names).toContain(n);
});

it('a local model has no native twins, so nothing is withheld', () => {
  expect(patchToolsOmittedFor('local/qwen')).toEqual([]);
});

it('reads the omitted tools from the command line, not the environment', () => {
  expect(parseOmitToolsArg(['/x/mcp.js', '--omit-tools=patch_agent,patch_loop'])).toEqual([
    'patch_agent',
    'patch_loop',
  ]);
  expect(parseOmitToolsArg(['/x/mcp.js'])).toEqual([]);
});
