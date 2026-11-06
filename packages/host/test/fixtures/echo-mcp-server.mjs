// A minimal stdio MCP server for sharedMcp tests: one tool, `pid`, that
// returns this process's id, so a test can tell how many children ran.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'echo', version: '1.0.0' });
server.tool('pid', 'process id', async () => ({
  content: [{ type: 'text', text: String(process.pid) }],
}));
await server.connect(new StdioServerTransport());
