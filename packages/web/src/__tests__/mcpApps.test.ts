import { describe, expect, it, vi } from 'vitest';
import {
  McpAppBridge,
  buildSrcdoc,
  cspFor,
  parseMcpToolName,
  toCallToolResult,
} from '../lib/mcpApps.js';

describe('parseMcpToolName', () => {
  it('splits server and tool', () => {
    expect(parseMcpToolName('mcp__dash__show_chart')).toEqual({
      server: 'dash',
      tool: 'show_chart',
    });
  });
  it('ignores Patch tools and non-MCP names', () => {
    expect(parseMcpToolName('mcp__patch__view_file')).toBeNull();
    expect(parseMcpToolName('Bash')).toBeNull();
    expect(parseMcpToolName(undefined)).toBeNull();
    expect(parseMcpToolName('mcp__dash')).toBeNull();
  });
});

describe('toCallToolResult', () => {
  it('keeps a result that already has content', () => {
    expect(
      toCallToolResult(
        { content: [{ type: 'text', text: 'a' }], structuredContent: { n: 1 } },
        false,
      ),
    ).toEqual({
      content: [{ type: 'text', text: 'a' }],
      structuredContent: { n: 1 },
    });
  });
  it('wraps a block array and a string, and carries the error flag', () => {
    expect(toCallToolResult([{ type: 'text', text: 'a' }], true)).toEqual({
      content: [{ type: 'text', text: 'a' }],
      isError: true,
    });
    expect(toCallToolResult('plain', false)).toEqual({
      content: [{ type: 'text', text: 'plain' }],
    });
  });
});

describe('csp', () => {
  it('is closed by default', () => {
    const c = cspFor(undefined);
    expect(c).toContain("default-src 'none'");
    expect(c).toContain("connect-src 'none'");
    expect(c).toContain("base-uri 'none'");
  });
  it('widens only to declared, well-formed domains', () => {
    const c = cspFor({
      csp: {
        connectDomains: ['https://api.x.com', "evil'; script-src *"],
        resourceDomains: ['https://cdn.x.com'],
      },
    });
    expect(c).toContain('connect-src https://api.x.com');
    expect(c).not.toContain('evil');
    expect(c).toContain('script-src');
    expect(c).toContain('https://cdn.x.com');
  });
  it('puts the CSP before the template, after a doctype', () => {
    expect(
      buildSrcdoc('<p>x</p>', undefined).startsWith('<meta http-equiv="Content-Security-Policy"'),
    ).toBe(true);
    const d = buildSrcdoc('<!DOCTYPE html><p>x</p>', undefined);
    expect(d.startsWith('<!DOCTYPE html><meta')).toBe(true);
  });
});

function setup() {
  const posted: Record<string, unknown>[] = [];
  const api = {
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    sendMessage: vi.fn(),
    openLink: vi.fn(),
    resize: vi.fn(),
  };
  const bridge = new McpAppBridge(
    api,
    {
      toolInput: { q: 1 },
      toolResult: { content: [] },
      theme: 'light',
      locale: 'en-GB',
      timeZone: 'UTC',
    },
    (m) => posted.push(m),
  );
  return { bridge, api, posted };
}
const rpc = (method: string, params?: unknown, id?: number) => ({
  jsonrpc: '2.0',
  method,
  params,
  ...(id !== undefined ? { id } : {}),
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('McpAppBridge', () => {
  it('answers initialize, then sends input and result after initialized', () => {
    const { bridge, posted } = setup();
    bridge.receive(rpc('ui/initialize', {}, 1));
    expect(posted[0]).toMatchObject({
      id: 1,
      result: { hostInfo: { name: 'Patch' }, hostContext: { theme: 'light' } },
    });
    bridge.receive(rpc('ui/notifications/initialized'));
    expect(posted.map((m) => m.method)).toEqual([
      undefined,
      'ui/notifications/tool-input',
      'ui/notifications/tool-result',
    ]);
  });
  it('runs a tool call and answers with its result or its error', async () => {
    const { bridge, api, posted } = setup();
    bridge.receive(rpc('tools/call', { name: 'refresh', arguments: { a: 1 } }, 2));
    await flush();
    expect(api.callTool).toHaveBeenCalledWith('refresh', { a: 1 });
    expect(posted[0]).toMatchObject({ id: 2, result: { content: [{ text: 'ok' }] } });
    api.callTool.mockRejectedValueOnce(new Error('nope'));
    bridge.receive(rpc('tools/call', { name: 'x' }, 3));
    await flush();
    expect(posted[1]).toMatchObject({ id: 3, error: { message: 'nope' } });
  });
  it('posts a user message into the chat', () => {
    const { bridge, api, posted } = setup();
    bridge.receive(
      rpc('ui/message', { role: 'user', content: { type: 'text', text: 'hello' } }, 4),
    );
    expect(api.sendMessage).toHaveBeenCalledWith('hello');
    expect(posted[0]).toMatchObject({ id: 4, result: {} });
    bridge.receive(
      rpc('ui/message', { role: 'assistant', content: { type: 'text', text: 'x' } }, 5),
    );
    expect(posted[1]).toMatchObject({ id: 5, error: {} });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('opens only http(s) links', () => {
    const { bridge, api, posted } = setup();
    bridge.receive(rpc('ui/open-link', { url: 'javascript:alert(1)' }, 6));
    expect(api.openLink).not.toHaveBeenCalled();
    expect(posted[0]).toMatchObject({ error: {} });
    bridge.receive(rpc('ui/open-link', { url: 'https://example.com' }, 7));
    expect(api.openLink).toHaveBeenCalledWith('https://example.com');
  });
  it('resizes, rejects unknown methods, ignores non-RPC', () => {
    const { bridge, api, posted } = setup();
    bridge.receive(rpc('ui/notifications/size-changed', { height: 321.2 }));
    expect(api.resize).toHaveBeenCalledWith(322);
    bridge.receive(rpc('what/ever', {}, 8));
    expect(posted[0]).toMatchObject({ id: 8, error: { code: -32601 } });
    bridge.receive('hi');
    bridge.receive({ method: 'ui/initialize' });
    expect(posted).toHaveLength(1);
  });
  it('tells a ready app when the theme changes', () => {
    const { bridge, posted } = setup();
    bridge.setTheme('dark');
    expect(posted).toHaveLength(0);
    bridge.receive(rpc('ui/notifications/initialized'));
    bridge.setTheme('dark');
    expect(posted.at(-1)).toMatchObject({
      method: 'ui/notifications/host-context-changed',
      params: { theme: 'dark' },
    });
  });
});
