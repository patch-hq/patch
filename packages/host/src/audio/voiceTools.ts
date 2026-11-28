// The MCP servers' tools on a voice call (spec/07 § Voice tools).
//
// The host is the MCP client, not the voice provider: it connects to each
// configured server (`mcpClient.ts`, the list Settings → MCP edits and every
// chat's agent already uses), lists its tools at the start of each call, hands
// the voice the ones not turned off with their own schemas, and runs the voice's
// calls through MCP, the result returning into the call.
//
// Only the turned-off names are stored (`voiceOff`, by the server's tool name),
// so a tool a server adds later is on, one it removes simply disappears and one
// it renames is a new tool. Nothing here remembers a tool list: each call reads
// it, and each tool call reads it again before running, so a tool that went
// away or was turned off mid-call is refused, naming it. A server that cannot
// be reached is reported on the call bar and its tools are left out; nothing
// pretends to have them.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Logger } from 'pino';
import type { McpServerConfig, McpServerTools, VoiceToolGroup } from '@patch/wire';
import { connectMcpClient, mcpConnectionKey, type SecretLookup } from '../mcpClient.js';
import type { VoiceToolSpec } from './voiceAgent.js';

/** The longest a provider accepts a function name. */
const MAX_TOOL_NAME = 64;
const CONNECT_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 20_000;

/** One tool of a server as the host read it. */
interface ListedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What the voice is given from the servers for one call. */
export interface McpVoiceSet {
  specs: VoiceToolSpec[];
  /** Why some server or tool was left out, one line each, for the call bar. */
  problems: string[];
  /** The server and tool a declared name stands for, or undefined if it is not one of these. */
  resolve(name: string): { server: string; tool: string } | undefined;
}

export interface VoiceToolboxDeps {
  logger: Logger;
  /** The host's MCP servers, read at each call so an edit reaches the next one. */
  servers: () => McpServerConfig[];
  /** Patch's own tool groups turned off for the voice. */
  groupsOff: () => VoiceToolGroup[];
  secrets: SecretLookup;
  /** Told what each server offered whenever it is listed, for Settings. */
  onListed?: (tools: Record<string, McpServerTools>) => void;
  /** Connect to a server; real servers by default, a fake in tests. */
  connect?: (spec: McpServerConfig, onToolsChanged: () => void) => Promise<Client>;
}

/** The name a server's tool is declared under: namespaced, and within what providers accept. */
export function declaredName(server: string, tool: string): string {
  return `${server}__${tool.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

export class VoiceToolbox {
  private readonly clients = new Map<string, Promise<Client>>();

  constructor(private readonly deps: VoiceToolboxDeps) {}

  groupsOff(): VoiceToolGroup[] {
    return this.deps.groupsOff();
  }

  private client(spec: McpServerConfig): Promise<Client> {
    const key = mcpConnectionKey(spec);
    let p = this.clients.get(key);
    if (!p) {
      const connect =
        this.deps.connect ??
        ((s: McpServerConfig, changed: () => void) =>
          connectMcpClient(s, this.deps.secrets, {
            timeoutMs: CONNECT_TIMEOUT_MS,
            onToolsChanged: changed,
          }));
      p = connect(spec, () => {
        // The next read lists again anyway; refresh Settings' view of it now.
        void this.describeOne(spec).catch((err: unknown) =>
          this.deps.logger.warn({ server: spec.name, err: String(err) }, 'voice: re-list failed'),
        );
      });
      this.clients.set(key, p);
      p.catch(() => this.clients.delete(key));
    }
    return p;
  }

  /** A connection that failed mid-use is dropped, so the next read connects afresh. */
  private drop(spec: McpServerConfig): void {
    const key = mcpConnectionKey(spec);
    const p = this.clients.get(key);
    this.clients.delete(key);
    void p?.then((c) => c.close()).catch(() => undefined);
  }

  /** The tools a server offers right now. */
  private async list(spec: McpServerConfig): Promise<ListedTool[]> {
    try {
      const client = await this.client(spec);
      const tools: ListedTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: LIST_TIMEOUT_MS,
        });
        for (const t of page.tools) {
          tools.push({
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema as Record<string, unknown>,
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    } catch (err) {
      this.drop(spec);
      throw err;
    }
  }

  /** Read one server and tell Settings what it offers, or why it could not say. */
  private async describeOne(spec: McpServerConfig): Promise<McpServerTools> {
    let out: McpServerTools;
    try {
      const tools = await this.list(spec);
      out = { tools: tools.map((t) => ({ name: t.name, description: t.description })) };
    } catch (err) {
      out = { error: (err as Error).message || String(err) };
    }
    this.deps.onListed?.({ [spec.name]: out });
    return out;
  }

  /** Every configured server's tools now, for Settings (turned on for the voice or not). */
  async describeAll(): Promise<Record<string, McpServerTools>> {
    // Only servers on for the voice are read: one that is off is not connected to here.
    const specs = this.deps.servers().filter((s) => s.voice);
    const entries = await Promise.all(
      specs.map(async (s) => [s.name, await this.describeOne(s)] as const),
    );
    return Object.fromEntries(entries);
  }

  /** The servers' tools for a call that is starting: listed now, the turned-off ones left out. */
  async open(): Promise<McpVoiceSet> {
    const specs: VoiceToolSpec[] = [];
    const problems: string[] = [];
    const byName = new Map<string, { server: string; tool: string }>();
    const servers = this.deps.servers().filter((s) => s.voice);
    const read = await Promise.all(
      servers.map(async (s) => {
        try {
          return { s, tools: await this.list(s) };
        } catch (err) {
          const why = (err as Error).message || String(err);
          this.deps.logger.error({ server: s.name, err: why }, 'voice: MCP server unavailable');
          problems.push(`${s.name} tools are not available on this call: ${why}`);
          return { s, tools: [] as ListedTool[] };
        }
      }),
    );
    for (const { s, tools } of read) {
      this.deps.onListed?.({
        [s.name]: { tools: tools.map((t) => ({ name: t.name, description: t.description })) },
      });
      for (const t of tools) {
        if (s.voiceOff.includes(t.name)) continue;
        const name = declaredName(s.name, t.name);
        if (name.length > MAX_TOOL_NAME || byName.has(name)) {
          problems.push(
            `${s.name}'s tool ${t.name} is left out: its name ${
              byName.has(name) ? 'clashes with another tool' : 'is too long for the voice'
            }`,
          );
          continue;
        }
        byName.set(name, { server: s.name, tool: t.name });
        specs.push({
          name,
          description: t.description || `${t.name} (${s.name})`,
          schema: t.inputSchema,
        });
      }
    }
    return { specs, problems, resolve: (n) => byName.get(n) };
  }

  /**
   * Run one tool of a server for the voice and answer in words. The server's
   * tool list is read again first: a tool it no longer has, or that was turned
   * off since the call began, is refused. A server's own error is returned as
   * the failure it is.
   */
  async call(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const spec = this.deps.servers().find((s) => s.name === server);
    if (!spec || !spec.voice) throw new Error(`${server} is no longer on for the voice`);
    if (spec.voiceOff.includes(tool)) throw new Error(`${tool} was turned off for the voice`);
    const listed = await this.list(spec);
    if (!listed.some((t) => t.name === tool)) {
      throw new Error(`${server} no longer has a tool called ${tool}`);
    }
    let result;
    try {
      const client = await this.client(spec);
      result = await client.callTool({ name: tool, arguments: args });
    } catch (err) {
      this.drop(spec);
      throw err;
    }
    const text = mcpResultText(result);
    if (result.isError === true) throw new Error(text || `${tool} failed`);
    return text;
  }

  /** Close every connection (host shutdown). */
  async close(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((p) => p.then((c) => c.close()).catch(() => undefined)));
  }
}

/** What a tool result says, as text the voice can use. Anything else is named, not dropped. */
export function mcpResultText(result: unknown): string {
  const r = result as { content?: unknown; structuredContent?: unknown };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const block of r.content as Array<{ type?: string; text?: string }>) {
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      else parts.push(`[${block.type ?? 'unknown'} content not shown to the voice]`);
    }
  }
  if (parts.length === 0 && r.structuredContent !== undefined) {
    parts.push(JSON.stringify(r.structuredContent));
  }
  return parts.join('\n');
}
