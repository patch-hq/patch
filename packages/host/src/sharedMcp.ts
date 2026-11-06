// One MCP server process per host, shared by every chat that wants it.
//
// A chat used to start its own copy of every enabled MCP server (a headless
// Chromium for `playwright`, another for `chrome-devtools`, ...), so a host
// running many chats was starting dozens of heavy children and the load starved
// the host's own heartbeat. Now each distinct server (command, args, env, cwd)
// is spawned once, lazily, and chats reach it over a loopback streamable-HTTP
// endpoint the host serves. The chat sees an ordinary `http` MCP server.
//
// How it works: one upstream MCP `Client` per shared server talks to the stdio
// child. Every chat that connects gets its own MCP session on our HTTP server
// (a low-level `Server` + `StreamableHTTPServerTransport`) whose requests are
// forwarded to that one client. The upstream is connected on demand and stopped
// after it has been idle for a while; the next request starts it again.
//
// There is no fallback: if the child cannot start, the request that needed it
// gets an HTTP 502 and the chat's MCP status shows the server as failed
// (`mcpSupervisor.ts` then reconnects it with backoff, as before).
//
// A shared server is shared state: two chats driving the same `playwright`
// see the same browser. That is the cost of sharing, and the reason a server
// with different env or cwd is a separate instance.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  isInitializeRequest,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js';

export interface SharedMcpSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface SharedMcpOptions {
  /** Stop an upstream child after this long with no request (ms). */
  idleMs?: number;
  /** Drop a chat session after this long with no request (ms). */
  sessionIdleMs?: number;
  /** Per-call limit upstream, ms. */
  toolTimeoutMs?: number;
  log?: (line: string) => void;
}

interface Upstream {
  client: Client;
  capabilities: ServerCapabilities;
  instructions: string | undefined;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastUsed: number;
}

class Shared {
  upstream: Promise<Upstream> | undefined;
  readonly sessions = new Map<string, Session>();
  lastUsed = Date.now();
  /** POST requests being served: an upstream is never stopped under one. */
  inflight = 0;
  constructor(
    readonly id: string,
    readonly spec: SharedMcpSpec,
    readonly cwd: string | undefined,
  ) {}
}

export class SharedMcpPool {
  private readonly idleMs: number;
  private readonly sessionIdleMs: number;
  private readonly toolTimeoutMs: number;
  private readonly log: (line: string) => void;
  private readonly token = randomBytes(18).toString('hex');
  private readonly shared = new Map<string, Shared>();
  private http: HttpServer | undefined;
  private port: Promise<number> | undefined;
  private port_ = 0;
  private sweep: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(opts: SharedMcpOptions = {}) {
    this.idleMs = opts.idleMs ?? 30 * 60_000;
    this.sessionIdleMs = opts.sessionIdleMs ?? 24 * 60 * 60_000;
    this.toolTimeoutMs = opts.toolTimeoutMs ?? 3_660_000;
    this.log = opts.log ?? ((l) => console.warn(l));
  }

  /**
   * The loopback URL a chat connects to for this server. Synchronous: nothing
   * is spawned here, the child starts when the chat first connects. `listen()`
   * must have resolved.
   */
  urlFor(spec: SharedMcpSpec, cwd?: string): string {
    if (this.port_ === 0) throw new Error('shared MCP pool is not listening: call listen() first');
    const id = createHash('sha256')
      .update(JSON.stringify([spec.command, spec.args, spec.env, cwd ?? null]))
      .digest('hex')
      .slice(0, 16);
    if (!this.shared.has(id)) this.shared.set(id, new Shared(id, spec, cwd));
    return `http://127.0.0.1:${this.port_}/mcp/${this.token}/${id}`;
  }

  /** Start the loopback HTTP endpoint (idempotent). */
  async listen(): Promise<void> {
    if (this.closed) throw new Error('shared MCP pool is closed');
    this.port ??= new Promise<number>((resolve, reject) => {
      const http = createServer((req, res) => {
        void this.handle(req, res).catch((err: unknown) => {
          this.log(`shared mcp: request failed: ${String(err)}`);
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: String(err) }));
          } else {
            res.end();
          }
        });
      });
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => {
        this.port_ = (http.address() as AddressInfo).port;
        resolve(this.port_);
      });
      this.http = http;
      this.sweep = setInterval(() => void this.reap(), 60_000);
      this.sweep.unref();
    });
    await this.port;
  }

  /** Stop the endpoint and every upstream child. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.sweep) clearInterval(this.sweep);
    for (const sh of this.shared.values()) {
      for (const s of sh.sessions.values()) await s.transport.close().catch(() => undefined);
      await this.stopUpstream(sh);
    }
    this.shared.clear();
    const http = this.http;
    if (http) {
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    }
  }

  /** Number of upstream children currently running (for tests and diagnostics). */
  runningCount(): number {
    return [...this.shared.values()].filter((s) => s.upstream !== undefined).length;
  }

  private async handle(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const m = /^\/mcp\/([0-9a-f]+)\/([0-9a-f]+)$/.exec((req.url ?? '').split('?')[0] ?? '');
    if (!m || m[1] !== this.token) {
      res.writeHead(404).end();
      return;
    }
    const sh = this.shared.get(m[2]!);
    if (!sh) {
      res.writeHead(404).end();
      return;
    }
    sh.lastUsed = Date.now();
    const sid = req.headers['mcp-session-id'];
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    if (typeof sid === 'string') {
      const s = sh.sessions.get(sid);
      if (!s) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown MCP session' }));
        return;
      }
      s.lastUsed = Date.now();
      await this.serve(sh, s.transport, req, res, body);
      return;
    }
    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing MCP session' }));
      return;
    }
    const up = await this.ensureUpstream(sh);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sh.sessions.set(id, session);
      },
    });
    const server = this.buildSession(sh, up);
    const session: Session = { transport, server, lastUsed: Date.now() };
    transport.onclose = () => {
      if (transport.sessionId) sh.sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await this.serve(sh, transport, req, res, body);
  }

  private async serve(
    sh: Shared,
    transport: StreamableHTTPServerTransport,
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
    body: unknown,
  ): Promise<void> {
    if (req.method !== 'POST') return transport.handleRequest(req, res, body);
    sh.inflight++;
    res.once('close', () => {
      sh.inflight--;
      sh.lastUsed = Date.now();
    });
    return transport.handleRequest(req, res, body);
  }

  /** The per-chat face of the shared client: forwards each request upstream. */
  private buildSession(sh: Shared, up: Upstream): Server {
    const server = new Server(
      { name: sh.spec.name, version: '1.0.0' },
      {
        capabilities: up.capabilities,
        ...(up.instructions ? { instructions: up.instructions } : {}),
      },
    );
    const opts = { timeout: this.toolTimeoutMs, resetTimeoutOnProgress: true };
    const client = async (): Promise<Client> => {
      sh.lastUsed = Date.now();
      return (await this.ensureUpstream(sh)).client;
    };
    if (up.capabilities.tools) {
      server.setRequestHandler(ListToolsRequestSchema, async (r) =>
        (await client()).listTools(r.params, opts),
      );
      server.setRequestHandler(CallToolRequestSchema, async (r) =>
        (await client()).callTool(r.params, undefined, opts),
      );
    }
    if (up.capabilities.resources) {
      server.setRequestHandler(ListResourcesRequestSchema, async (r) =>
        (await client()).listResources(r.params, opts),
      );
      server.setRequestHandler(ListResourceTemplatesRequestSchema, async (r) =>
        (await client()).listResourceTemplates(r.params, opts),
      );
      server.setRequestHandler(ReadResourceRequestSchema, async (r) =>
        (await client()).readResource(r.params, opts),
      );
    }
    if (up.capabilities.prompts) {
      server.setRequestHandler(ListPromptsRequestSchema, async (r) =>
        (await client()).listPrompts(r.params, opts),
      );
      server.setRequestHandler(GetPromptRequestSchema, async (r) =>
        (await client()).getPrompt(r.params, opts),
      );
    }
    return server;
  }

  private ensureUpstream(sh: Shared): Promise<Upstream> {
    if (sh.upstream) return sh.upstream;
    const p = (async (): Promise<Upstream> => {
      const transport = new StdioClientTransport({
        command: sh.spec.command,
        args: sh.spec.args,
        env: { ...(process.env as Record<string, string>), ...sh.spec.env },
        ...(sh.cwd ? { cwd: sh.cwd } : {}),
        stderr: 'inherit',
      });
      const client = new Client({ name: 'patch-shared-mcp', version: '1.0.0' });
      transport.onclose = () => {
        // The child went away: the next request starts a fresh one.
        if (sh.upstream === p) sh.upstream = undefined;
        this.log(`shared mcp: ${sh.spec.name} exited`);
      };
      this.log(`shared mcp: starting ${sh.spec.name} (${sh.spec.command})`);
      await client.connect(transport, { timeout: 120_000 });
      return {
        client,
        capabilities: client.getServerCapabilities() ?? {},
        instructions: client.getInstructions(),
      };
    })();
    sh.upstream = p;
    p.catch((err: unknown) => {
      if (sh.upstream === p) sh.upstream = undefined;
      this.log(`shared mcp: ${sh.spec.name} failed to start: ${String(err)}`);
    });
    return p;
  }

  private async stopUpstream(sh: Shared): Promise<void> {
    const p = sh.upstream;
    sh.upstream = undefined;
    if (!p) return;
    const up = await p.catch(() => undefined);
    await up?.client.close().catch(() => undefined);
  }

  private async reap(): Promise<void> {
    const now = Date.now();
    for (const sh of this.shared.values()) {
      for (const [id, s] of sh.sessions) {
        if (now - s.lastUsed > this.sessionIdleMs) {
          sh.sessions.delete(id);
          await s.transport.close().catch(() => undefined);
        }
      }
      if (sh.upstream && sh.inflight === 0 && now - sh.lastUsed >= this.idleMs) {
        this.log(`shared mcp: stopping idle ${sh.spec.name}`);
        await this.stopUpstream(sh);
      }
    }
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
