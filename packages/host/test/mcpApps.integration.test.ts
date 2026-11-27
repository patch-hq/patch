// MCP Apps against a real stdio MCP server, through the real SDK client.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { McpApps, stdioConnector } from '../src/mcpApps.js';

const script = fileURLToPath(new URL('./fixtures/mcp-app-server.mjs', import.meta.url));
const logger = pino({ level: 'silent' });
const spec = { name: 'dash', command: process.execPath, args: [script], env: {}, enabled: true };

describe('McpApps with a real server', () => {
  it('serves the template, runs an app tool, refuses a model-only one', async () => {
    const apps = new McpApps({
      logger,
      serversFor: () => [spec],
      folderOf: () => '/f',
      connect: stdioConnector(logger),
    });
    const ask = async (op: 'resource' | 'call', tool: string, args?: Record<string, unknown>) => {
      const out: WireEvent[] = [];
      await apps.handle(
        {
          type: 'patch.mcp_app.request',
          requestId: 'r',
          hostId: 'h',
          chatId: 'c',
          op,
          server: 'dash',
          tool,
          ...(args ? { arguments: args } : {}),
        },
        (e) => out.push(e),
        'h',
      );
      return out[0] as Record<string, unknown>;
    };
    const tpl = await ask('resource', 'show');
    expect(tpl).toMatchObject({ ok: true, hasUi: true, uiMeta: { prefersBorder: true } });
    expect(String(tpl.html)).toContain('ui/initialize');
    expect(await ask('call', 'bump', { by: 2 })).toMatchObject({
      ok: true,
      result: { content: [{ text: 'bumped 2' }] },
    });
    expect(await ask('call', 'secret')).toMatchObject({
      ok: false,
      error: { code: 'not_app_visible' },
    });
    expect(await ask('resource', 'bump')).toMatchObject({ ok: true, hasUi: false });
  }, 60_000);
});
