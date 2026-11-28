// Connecting to one configured MCP server as a client (Settings → MCP), by
// either transport: a stdio child the host starts, or a remote Streamable HTTP
// server with a bearer token. Used wherever the host itself, not a chat's
// agent, talks to a server: the voice agent's tools (`audio/voiceTools.ts`) and
// MCP Apps (`mcpApps.ts`).
//
// An HTTP server's token is never in the config: `tokenSecret` names an entry
// of the host's Secrets store, read here at connect time. A named secret that
// is not set is an error, never a connection without credentials.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from '@patch/wire';

/** Reads one entry of the host's Secrets store. */
export type SecretLookup = (key: string) => string | undefined;

/** The headers an HTTP server is sent: its bearer token, read from Secrets. */
export function mcpHttpHeaders(
  spec: Extract<McpServerConfig, { url: string }>,
  secrets: SecretLookup,
): Record<string, string> {
  if (spec.tokenSecret === undefined) return {};
  const token = secrets(spec.tokenSecret);
  if (token === undefined || token === '') {
    throw new Error(
      `MCP server "${spec.name}" needs the secret ${spec.tokenSecret}, which is not set (Settings → Secrets)`,
    );
  }
  return { Authorization: `Bearer ${token}` };
}

/** Identifies one connection: the same key is the same server, so one client serves it. */
export function mcpConnectionKey(spec: McpServerConfig): string {
  return 'url' in spec
    ? JSON.stringify([spec.name, spec.url, spec.tokenSecret ?? null])
    : JSON.stringify([spec.name, spec.command, spec.args, spec.env]);
}

/** A connected client; `onToolsChanged` fires when the server says its tool list changed. */
export async function connectMcpClient(
  spec: McpServerConfig,
  secrets: SecretLookup,
  opts: { timeoutMs: number; onToolsChanged?: () => void },
): Promise<Client> {
  const transport =
    'url' in spec
      ? new StreamableHTTPClientTransport(new URL(spec.url), {
          requestInit: { headers: mcpHttpHeaders(spec, secrets) },
        })
      : new StdioClientTransport({
          command: spec.command,
          args: spec.args,
          env: { ...(process.env as Record<string, string>), ...spec.env },
          stderr: 'inherit',
        });
  const client = new Client({ name: 'patch-host', version: '1.0.0' });
  const { onToolsChanged } = opts;
  if (onToolsChanged) {
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => onToolsChanged());
  }
  await client.connect(transport, { timeout: opts.timeoutMs });
  return client;
}
