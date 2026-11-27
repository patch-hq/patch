import { describe, expect, it, vi } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { McpApps, MCP_APP_MIME, type McpAppClient } from '../src/mcpApps.js';

const logger = { info: vi.fn(), warn: vi.fn() } as never;
const spec = { name: 'dash', command: 'x', args: [], env: {}, enabled: true };

function fake(over: Partial<McpAppClient> = {}): McpAppClient {
  return {
    listTools: async () => ({
      tools: [
        { name: 'show', _meta: { ui: { resourceUri: 'ui://dash/show' } } },
        { name: 'plain' },
        { name: 'refresh', _meta: { ui: { resourceUri: 'ui://dash/show', visibility: ['app'] } } },
        { name: 'hidden', _meta: { ui: { visibility: ['model'] } } },
      ],
    }),
    readResource: async () => ({
      contents: [
        {
          uri: 'ui://dash/show',
          mimeType: MCP_APP_MIME,
          text: '<p>hi</p>',
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    }),
    callTool: async () => ({ content: [{ type: 'text', text: 'done' }] }),
    ...over,
  };
}

async function run(client: McpAppClient, ev: Record<string, unknown>) {
  const sent: WireEvent[] = [];
  const connect = vi.fn(async () => client);
  const apps = new McpApps({
    logger,
    serversFor: () => [spec],
    folderOf: (id) => (id === 'c1' ? '/f' : undefined),
    connect,
  });
  await apps.handle(
    {
      type: 'patch.mcp_app.request',
      requestId: 'r',
      hostId: 'h',
      chatId: 'c1',
      server: 'dash',
      tool: 'show',
      op: 'resource',
      ...ev,
    } as never,
    (e) => sent.push(e),
    'h',
  );
  return { sent: sent[0] as Record<string, unknown>, connect };
}

describe('McpApps', () => {
  it('returns the template and its ui meta', async () => {
    const { sent } = await run(fake(), {});
    expect(sent).toMatchObject({
      ok: true,
      hasUi: true,
      html: '<p>hi</p>',
      uiMeta: { prefersBorder: true },
    });
  });
  it('reports a tool with no UI as hasUi false', async () => {
    const { sent } = await run(fake(), { tool: 'plain' });
    expect(sent).toMatchObject({ ok: true, hasUi: false });
  });
  it('refuses a template with the wrong mime type', async () => {
    const c = fake({
      readResource: async () => ({ contents: [{ uri: 'u', mimeType: 'text/html', text: 'x' }] }),
    });
    const { sent } = await run(c, {});
    expect(sent).toMatchObject({ ok: false, error: { code: 'bad_resource' } });
  });
  it('refuses a non ui:// resource', async () => {
    const c = fake({
      listTools: async () => ({
        tools: [{ name: 'show', _meta: { ui: { resourceUri: 'https://x' } } }],
      }),
    });
    const { sent } = await run(c, {});
    expect(sent).toMatchObject({ ok: false, error: { code: 'bad_resource' } });
  });
  it('runs an app-visible tool', async () => {
    const { sent } = await run(fake(), { op: 'call', tool: 'refresh', arguments: { a: 1 } });
    expect(sent).toMatchObject({ ok: true, result: { content: [{ text: 'done' }] } });
  });
  it('refuses a model-only tool', async () => {
    const { sent } = await run(fake(), { op: 'call', tool: 'hidden' });
    expect(sent).toMatchObject({ ok: false, error: { code: 'not_app_visible' } });
  });
  it('names a missing tool, server and chat', async () => {
    expect((await run(fake(), { tool: 'nope' })).sent).toMatchObject({
      error: { code: 'tool_not_found' },
    });
    expect((await run(fake(), { server: 'zz' })).sent).toMatchObject({
      error: { code: 'server_not_found' },
    });
    expect((await run(fake(), { chatId: 'zz' })).sent).toMatchObject({
      error: { code: 'server_not_found' },
    });
  });
  it('reports a server that will not start, and retries next time', async () => {
    const sent: WireEvent[] = [];
    let n = 0;
    const apps = new McpApps({
      logger,
      serversFor: () => [spec],
      folderOf: () => '/f',
      connect: async () => {
        if (n++ === 0) throw new Error('boom');
        return fake();
      },
    });
    const ev = {
      type: 'patch.mcp_app.request',
      requestId: 'r',
      hostId: 'h',
      chatId: 'c1',
      server: 'dash',
      tool: 'show',
      op: 'resource',
    } as never;
    await apps.handle(ev, (e) => sent.push(e), 'h');
    await new Promise((r) => setTimeout(r, 0));
    await apps.handle(ev, (e) => sent.push(e), 'h');
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'server_failed' } });
    expect(sent[1]).toMatchObject({ ok: true, hasUi: true });
  });
});
