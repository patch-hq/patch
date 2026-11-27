// A real stdio MCP server with one MCP App: `show` has a UI, `bump` is app-only.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'dash', version: '1.0.0' });
const html =
  '<!doctype html><html><body><button id="b">bump</button><script>' +
  'const send=(m)=>parent.postMessage({jsonrpc:"2.0",...m},"*");' +
  'send({id:1,method:"ui/initialize",params:{}});' +
  'addEventListener("message",e=>{if(e.data.id===1)send({method:"ui/notifications/initialized"});});' +
  '</script></body></html>';
server.registerResource('show-ui', 'ui://dash/show', { mimeType: 'text/html;profile=mcp-app' }, async () => ({
  contents: [{ uri: 'ui://dash/show', mimeType: 'text/html;profile=mcp-app', text: html, _meta: { ui: { prefersBorder: true } } }],
}));
server.registerTool('show', { description: 'show', inputSchema: {}, _meta: { ui: { resourceUri: 'ui://dash/show' } } }, async () => ({ content: [{ type: 'text', text: 'shown' }] }));
server.registerTool('bump', { description: 'bump', inputSchema: { by: z.number() }, _meta: { ui: { visibility: ['app'] } } }, async ({ by }) => ({ content: [{ type: 'text', text: `bumped ${by}` }] }));
server.registerTool('secret', { description: 'model only', inputSchema: {}, _meta: { ui: { visibility: ['model'] } } }, async () => ({ content: [{ type: 'text', text: 's' }] }));
await server.connect(new StdioServerTransport());
