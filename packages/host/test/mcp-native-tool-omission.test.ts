// One tool per job (principles.md § Patch-owned state): where a provider cannot
// switch its native subagent/wake/goal tools off, Patch's versions are withheld
// from that provider's chats.

import { it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PATCH_TOOLS_REPLACING_NATIVE, patchToolsOmittedFor } from '@patch/wire';
import { buildPatchToolsServer } from '../src/mcp.js';

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

it('withholds Patch’s replacements where the provider keeps its native tools', async () => {
  const names = await toolNames(patchToolsOmittedFor('openai/gpt-5'));
  for (const n of PATCH_TOOLS_REPLACING_NATIVE) expect(names).not.toContain(n);
  expect(names).toContain('patch_peek');
  expect(names).toContain('patch_send_to');
});

it('offers every Patch tool where the provider can switch its native ones off', async () => {
  expect(patchToolsOmittedFor('claude-opus-5')).toEqual([]);
  const names = await toolNames(patchToolsOmittedFor('claude-opus-5'));
  for (const n of PATCH_TOOLS_REPLACING_NATIVE) expect(names).toContain(n);
});

it('withholds them for a local model too', () => {
  expect(patchToolsOmittedFor('local/qwen')).toEqual(PATCH_TOOLS_REPLACING_NATIVE);
});
