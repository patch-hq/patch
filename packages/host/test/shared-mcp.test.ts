import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SharedMcpPool } from '../src/sharedMcp.js';
import { buildSdkEnv, type SdkRunOptions } from '../src/sdkBackend.js';
import { codexMcpServers } from '../src/codexBackend.js';

const fixture = fileURLToPath(new URL('./fixtures/echo-mcp-server.mjs', import.meta.url));
const spec = { name: 'echo', command: process.execPath, args: [fixture], env: {} };

async function connect(url: string): Promise<Client> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  return c;
}

async function pid(c: Client): Promise<string> {
  const r = (await c.callTool({ name: 'pid', arguments: {} })) as {
    content: { text: string }[];
  };
  return r.content[0]!.text;
}

let pool: SharedMcpPool | undefined;
afterEach(async () => {
  await pool?.close();
  pool = undefined;
});

describe('SharedMcpPool', () => {
  it('serves many chats from one child process', async () => {
    pool = new SharedMcpPool({ log: () => undefined });
    await pool.listen();
    const url = pool.urlFor(spec);
    expect(pool.runningCount()).toBe(0); // nothing starts until a chat connects
    const a = await connect(url);
    const b = await connect(pool.urlFor(spec));
    expect((await a.listTools()).tools.map((t) => t.name)).toEqual(['pid']);
    const pa = await pid(a);
    const pb = await pid(b);
    expect(pa).toBe(pb);
    expect(pa).not.toBe(String(process.pid));
    expect(pool.runningCount()).toBe(1);
    await a.close();
    await b.close();
  });

  it('runs a server with different env as a separate child', async () => {
    pool = new SharedMcpPool({ log: () => undefined });
    await pool.listen();
    const a = await connect(pool.urlFor(spec));
    const b = await connect(pool.urlFor({ ...spec, env: { X: '1' } }));
    expect(await pid(a)).not.toBe(await pid(b));
    expect(pool.runningCount()).toBe(2);
    await a.close();
    await b.close();
  });

  it('fails loudly when the child cannot start', async () => {
    pool = new SharedMcpPool({ log: () => undefined });
    await pool.listen();
    const bad = { name: 'bad', command: '/nonexistent/mcp', args: [], env: {} };
    await expect(connect(pool.urlFor(bad))).rejects.toThrow();
    expect(pool.runningCount()).toBe(0);
  });

  it('restarts the child after it has gone idle', async () => {
    pool = new SharedMcpPool({ idleMs: 0, log: () => undefined });
    await pool.listen();
    const a = await connect(pool.urlFor(spec));
    const first = await pid(a);
    await (pool as unknown as { reap(): Promise<void> }).reap();
    expect(pool.runningCount()).toBe(0);
    expect(await pid(a)).not.toBe(first);
    await a.close();
  });

  it('refuses a request without the pool token', async () => {
    pool = new SharedMcpPool({ log: () => undefined });
    await pool.listen();
    const url = pool.urlFor(spec).replace(/\/mcp\/[0-9a-f]+\//, '/mcp/deadbeef/');
    const res = await fetch(url, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });
});

describe('shared entries reach the backends', () => {
  const base = {
    mcpServer: { command: 'node', args: [], env: {} },
    extraMcpServers: [{ name: 'echo', url: 'http://127.0.0.1:1/mcp/t/i' }],
  } as unknown as SdkRunOptions;

  it('Claude gets an http server', () => {
    expect(buildSdkEnv(base).mcpServers?.['echo']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:1/mcp/t/i',
    });
  });

  it('Codex gets a url server', () => {
    expect(codexMcpServers(base)?.['echo']).toEqual({
      url: 'http://127.0.0.1:1/mcp/t/i',
      enabled: true,
    });
  });
});
