// MCP Apps (SEP-1865) on the host: the MCP client a chat's UI talks through.
//
// A surface shows a tool result's UI template in a sandboxed frame. The
// template lives on the MCP server that owns the tool, and the frame's buttons
// call tools on that same server, so the host — which can already run that
// server for the chat's agent — connects to it as a client:
//
//   resource  list the server's tools, find the one named, read its
//             `_meta.ui.resourceUri` and return the HTML it points at;
//   call      run a tool for the UI, but only one the server marks visible to
//             apps (`_meta.ui.visibility` includes "app"; absent means both).
//
// Which servers exist for a chat is the same answer the agent gets: the host's
// enabled Settings → MCP list, then whatever Claude Code's own config names for
// the chat's folder (`claudeConfigMcp.ts`). One connection per server is kept
// for the host's life and dropped when its process exits.
//
// NO FALLBACK: a missing server, tool or template is an error the surface shows,
// never an empty frame.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Logger } from 'pino';
import type { McpServerConfig, PatchMcpAppRequestEvent, WireEvent } from '@patch/wire';

export const MCP_APP_MIME = 'text/html;profile=mcp-app';
const CONNECT_TIMEOUT_MS = 120_000;

/** The slice of an MCP client this needs; the real one is the SDK's `Client`. */
export interface McpAppClient {
  listTools(): Promise<{ tools: { name: string; _meta?: Record<string, unknown> }[] }>;
  readResource(p: { uri: string }): Promise<{
    contents: {
      uri: string;
      mimeType?: string;
      text?: string;
      blob?: string;
      _meta?: Record<string, unknown>;
    }[];
  }>;
  callTool(p: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
}

export type McpAppConnector = (spec: McpServerConfig) => Promise<McpAppClient>;

class McpAppError extends Error {
  constructor(
    readonly code: NonNullable<
      Extract<WireEvent, { type: 'patch.mcp_app.response' }>['error']
    >['code'],
    message: string,
  ) {
    super(message);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `_meta.ui` of a tool or resource; the SEP's flat `ui/resourceUri` key is read too. */
function uiMetaOf(meta: unknown): Record<string, unknown> {
  if (!isRecord(meta)) return {};
  const ui = isRecord(meta.ui) ? { ...meta.ui } : {};
  const flat = meta['ui/resourceUri'];
  if (ui.resourceUri === undefined && typeof flat === 'string') ui.resourceUri = flat;
  return ui;
}

export function stdioConnector(logger: Logger): McpAppConnector {
  return async (spec) => {
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: { ...(process.env as Record<string, string>), ...spec.env },
      stderr: 'inherit',
    });
    const client = new Client({ name: 'patch-mcp-apps', version: '1.0.0' });
    logger.info({ server: spec.name }, 'mcp apps: connecting');
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return client as unknown as McpAppClient;
  };
}

export interface McpAppsDeps {
  logger: Logger;
  /** Every server a chat in `folder` can see, enabled or not filtered already. */
  serversFor: (folder: string) => McpServerConfig[];
  folderOf: (chatId: string) => string | undefined;
  connect: McpAppConnector;
}

export class McpApps {
  private readonly clients = new Map<string, Promise<McpAppClient>>();

  constructor(private readonly deps: McpAppsDeps) {}

  private async clientFor(chatId: string, server: string): Promise<McpAppClient> {
    const folder = this.deps.folderOf(chatId);
    if (folder === undefined) {
      throw new McpAppError('server_not_found', `no chat ${chatId} on this host`);
    }
    const spec = this.deps.serversFor(folder).find((s) => s.name === server);
    if (!spec) {
      throw new McpAppError('server_not_found', `no MCP server "${server}" for this chat`);
    }
    const key = JSON.stringify([spec.name, spec.command, spec.args, spec.env]);
    let p = this.clients.get(key);
    if (!p) {
      p = this.deps.connect(spec);
      this.clients.set(key, p);
      p.catch((err: unknown) => {
        // A failed start must not be remembered: the next ask tries again.
        if (this.clients.get(key) === p) this.clients.delete(key);
        this.deps.logger.warn({ server, err: String(err) }, 'mcp apps: connect failed');
      });
    }
    try {
      return await p;
    } catch (err) {
      throw new McpAppError('server_failed', `${server}: ${(err as Error).message}`);
    }
  }

  private async toolOf(client: McpAppClient, server: string, tool: string) {
    const { tools } = await client.listTools();
    const found = tools.find((t) => t.name === tool);
    if (!found) throw new McpAppError('tool_not_found', `${server} has no tool "${tool}"`);
    return found;
  }

  async handle(
    event: PatchMcpAppRequestEvent,
    sender: (e: WireEvent) => void,
    hostId: string,
  ): Promise<void> {
    const base = { type: 'patch.mcp_app.response' as const, requestId: event.requestId, hostId };
    try {
      const client = await this.clientFor(event.chatId, event.server);
      const tool = await this.toolOf(client, event.server, event.tool);
      const ui = uiMetaOf(tool._meta);
      if (event.op === 'resource') {
        const uri = ui.resourceUri;
        if (typeof uri !== 'string') {
          sender({ ...base, ok: true, hasUi: false });
          return;
        }
        if (!uri.startsWith('ui://')) {
          throw new McpAppError('bad_resource', `resourceUri must be ui://, got ${uri}`);
        }
        const { contents } = await client.readResource({ uri });
        const item = contents[0];
        if (!item || typeof item.text !== 'string') {
          throw new McpAppError('bad_resource', `${uri} returned no text content`);
        }
        if ((item.mimeType ?? '').replace(/\s/g, '') !== MCP_APP_MIME) {
          throw new McpAppError(
            'bad_resource',
            `${uri} is ${item.mimeType ?? 'untyped'}, not ${MCP_APP_MIME}`,
          );
        }
        sender({ ...base, ok: true, hasUi: true, html: item.text, uiMeta: uiMetaOf(item._meta) });
        return;
      }
      const visibility = Array.isArray(ui.visibility) ? ui.visibility : ['model', 'app'];
      if (!visibility.includes('app')) {
        throw new McpAppError('not_app_visible', `${event.tool} is not callable from an app`);
      }
      const result = await client.callTool({ name: event.tool, arguments: event.arguments ?? {} });
      sender({ ...base, ok: true, result });
    } catch (err) {
      const e =
        err instanceof McpAppError ? err : new McpAppError('server_failed', (err as Error).message);
      this.deps.logger.warn({ code: e.code, server: event.server }, `mcp apps: ${e.message}`);
      sender({ ...base, ok: false, error: { code: e.code, message: e.message } });
    }
  }
}
