// The browser toolset is switched on by use: only patch_browser_open is listed
// at first, and a successful open lists the rest. A failed open leaves them off.

import { it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildPatchToolsServer } from '../src/mcp.js';

let srv: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (srv ? srv.close(() => r()) : r()));
  srv = undefined;
});

async function setup(openStatus: number) {
  const socketPath = join(mkdtempSync(join(tmpdir(), 'patch-gate-')), 'h.sock');
  srv = createServer((_req, res) => {
    res.writeHead(openStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify(openStatus === 200 ? { tabId: 't1' } : { error: 'browser_missing' }));
  });
  await new Promise<void>((r) => srv!.listen(socketPath, r));
  const server = buildPatchToolsServer({ hostSocketPath: socketPath, chatId: 'c1', localKey: 'k' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const names = async (): Promise<string[]> =>
    ((await client.listTools()).tools as { name: string }[]).map((t) => t.name);
  return { client, names };
}

it('lists only patch_browser_open until a browser has been opened', async () => {
  const { client, names } = await setup(200);
  const before = (await names()).filter((n) => n.startsWith('patch_browser_'));
  expect(before).toEqual(['patch_browser_open']);
  await client.callTool({ name: 'patch_browser_open', arguments: { url: 'https://example.com' } });
  const after = (await names()).filter((n) => n.startsWith('patch_browser_'));
  expect(after).toContain('patch_browser_read');
  expect(after).toContain('patch_browser_click');
  expect(after.length).toBeGreaterThan(15);
});

it('keeps them off when the open fails', async () => {
  const { client, names } = await setup(409);
  const res = (await client.callTool({
    name: 'patch_browser_open',
    arguments: { url: 'https://example.com' },
  })) as { isError?: boolean };
  expect(res.isError).toBe(true);
  expect((await names()).filter((n) => n.startsWith('patch_browser_'))).toEqual([
    'patch_browser_open',
  ]);
});

it('patch_spawn forwards account, and patch_list_accounts asks the host', async () => {
  const seen: Array<{ url: string; body: string }> = [];
  const socketPath = join(mkdtempSync(join(tmpdir(), 'patch-gate-')), 'h.sock');
  srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"chatId":"x"}');
    });
  });
  await new Promise<void>((r) => srv!.listen(socketPath, r));
  const server = buildPatchToolsServer({ hostSocketPath: socketPath, chatId: 'c1', localKey: 'k' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: 'patch_spawn', arguments: { folder: '/f', account: 'Work' } });
  await client.callTool({ name: 'patch_list_accounts', arguments: {} });
  expect(seen[0]!.url).toBe('/internal/spawn');
  expect(JSON.parse(seen[0]!.body)).toMatchObject({ folder: '/f', account: 'Work' });
  expect(seen[1]!.url).toBe('/internal/accounts');
});
