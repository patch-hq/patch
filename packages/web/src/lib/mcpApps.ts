// MCP Apps (SEP-1865) in a chat: the pieces that are not React.
//
// A tool result whose tool declares `_meta.ui.resourceUri` is drawn as the
// server's HTML template in a sandboxed frame. The frame speaks JSON-RPC 2.0
// over postMessage; `McpAppBridge` is the host's half of that conversation.
// The frame gets an opaque origin (`sandbox` without allow-same-origin), so it
// can reach neither the SPA's credential nor its DOM; what it may fetch is
// fixed by the CSP the template declares (`buildSrcdoc`).

/** `mcp__<server>__<tool>`, except Patch's own tools, which have no UI. */
export function parseMcpToolName(
  name: string | undefined,
): { server: string; tool: string } | null {
  if (!name?.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const i = rest.indexOf('__');
  if (i <= 0 || i + 2 >= rest.length) return null;
  const server = rest.slice(0, i);
  if (server === 'patch') return null;
  return { server, tool: rest.slice(i + 2) };
}

/** What a stored tool result is, as an MCP CallToolResult. */
export function toCallToolResult(stored: unknown, isError: boolean): Record<string, unknown> {
  if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
    const o = stored as Record<string, unknown>;
    if (Array.isArray(o.content)) return { ...o, ...(isError ? { isError: true } : {}) };
  }
  if (Array.isArray(stored)) return { content: stored, ...(isError ? { isError: true } : {}) };
  const text = typeof stored === 'string' ? stored : JSON.stringify(stored ?? '');
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

const list = (v: unknown): string =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && !/[\s;,'"]/.test(x)).join(' ')
    : '';

/** The CSP SEP-1865 prescribes, widened only by the domains the template declares. */
export function cspFor(uiMeta: Record<string, unknown> | undefined): string {
  const c = (uiMeta?.csp ?? {}) as Record<string, unknown>;
  const connect = list(c.connectDomains);
  const resources = list(c.resourceDomains);
  const frames = list(c.frameDomains);
  const base = list(c.baseUriDomains);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${resources}`.trim(),
    `style-src 'unsafe-inline' ${resources}`.trim(),
    `img-src data: blob: ${resources}`.trim(),
    `media-src data: blob: ${resources}`.trim(),
    `font-src data: ${resources}`.trim(),
    `connect-src ${connect || "'none'"}`,
    `frame-src ${frames || "'none'"}`,
    "object-src 'none'",
    `base-uri ${base || "'none'"}`,
  ].join('; ');
}

/** The template with its CSP stamped in ahead of any of its own markup. */
export function buildSrcdoc(html: string, uiMeta: Record<string, unknown> | undefined): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${cspFor(uiMeta).replace(/"/g, '&quot;')}">`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + meta + html.slice(doctype[0].length);
  return meta + html;
}

type Json = Record<string, unknown>;

export interface McpAppHostApi {
  /** Run a tool on the app's own server. Rejects with the host's refusal. */
  callTool(name: string, args: Json | undefined): Promise<Json>;
  /** Post a message from the app into the chat as the user. */
  sendMessage(text: string): void;
  /** Open a link outside the frame. */
  openLink(url: string): void;
  /** The frame asked for this height (px). */
  resize(height: number): void;
}

export interface McpAppContext {
  toolInput: Json | undefined;
  toolResult: Json;
  theme: 'light' | 'dark';
  locale: string;
  timeZone: string;
}

export const MCP_APP_PROTOCOL_VERSION = '2025-11-21';

/**
 * The host's side of the app's JSON-RPC. `post` sends a message to the frame;
 * `receive` takes one from it. Anything unrecognised is answered with a
 * JSON-RPC error rather than ignored, so an app finds out.
 */
export class McpAppBridge {
  private ready = false;
  constructor(
    private readonly api: McpAppHostApi,
    private readonly ctx: McpAppContext,
    private readonly post: (msg: Json) => void,
  ) {}

  private hostContext(): Json {
    return {
      theme: this.ctx.theme,
      displayMode: 'inline',
      availableDisplayModes: ['inline'],
      locale: this.ctx.locale,
      timeZone: this.ctx.timeZone,
      platform: 'web',
    };
  }

  private reply(id: unknown, result: Json): void {
    this.post({ jsonrpc: '2.0', id, result });
  }
  private fail(id: unknown, code: number, message: string): void {
    this.post({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** The theme changed while the app is open. */
  setTheme(theme: 'light' | 'dark'): void {
    this.ctx.theme = theme;
    if (this.ready) {
      this.post({
        jsonrpc: '2.0',
        method: 'ui/notifications/host-context-changed',
        params: { theme },
      });
    }
  }

  /** The chat is closing the app. */
  teardown(): void {
    this.post({ jsonrpc: '2.0', id: 'teardown', method: 'ui/resource-teardown', params: {} });
  }

  receive(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const m = raw as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return;
    const params = (typeof m.params === 'object' && m.params !== null ? m.params : {}) as Json;
    const hasId = m.id !== undefined;
    switch (m.method) {
      case 'ui/initialize':
        if (!hasId) return;
        this.reply(m.id, {
          protocolVersion: MCP_APP_PROTOCOL_VERSION,
          hostInfo: { name: 'Patch', version: '1' },
          hostCapabilities: { serverTools: {}, openLinks: {}, message: { text: {} } },
          hostContext: this.hostContext(),
        });
        return;
      case 'ui/notifications/initialized':
        this.ready = true;
        if (this.ctx.toolInput !== undefined) {
          this.post({
            jsonrpc: '2.0',
            method: 'ui/notifications/tool-input',
            params: { arguments: this.ctx.toolInput },
          });
        }
        this.post({
          jsonrpc: '2.0',
          method: 'ui/notifications/tool-result',
          params: this.ctx.toolResult,
        });
        return;
      case 'tools/call': {
        if (!hasId) return;
        const name = params.name;
        if (typeof name !== 'string') return this.fail(m.id, -32602, 'name is required');
        const args =
          typeof params.arguments === 'object' && params.arguments !== null
            ? (params.arguments as Json)
            : undefined;
        this.api.callTool(name, args).then(
          (result) => this.reply(m.id, result),
          (err: unknown) =>
            this.fail(m.id, -32000, err instanceof Error ? err.message : String(err)),
        );
        return;
      }
      case 'ui/message': {
        if (!hasId) return;
        const content = params.content as { type?: unknown; text?: unknown } | undefined;
        if (
          params.role !== 'user' ||
          content?.type !== 'text' ||
          typeof content.text !== 'string'
        ) {
          return this.fail(m.id, -32602, 'only a user text message is supported');
        }
        this.api.sendMessage(content.text);
        this.reply(m.id, {});
        return;
      }
      case 'ui/open-link': {
        if (!hasId) return;
        const url = typeof params.url === 'string' ? params.url : '';
        if (!/^https?:\/\//i.test(url)) return this.fail(m.id, -32602, 'only http(s) links open');
        this.api.openLink(url);
        this.reply(m.id, {});
        return;
      }
      case 'ui/request-display-mode':
        if (hasId) this.reply(m.id, { mode: 'inline' });
        return;
      case 'ui/update-model-context':
        if (hasId) this.fail(m.id, -32601, 'ui/update-model-context is not supported');
        return;
      case 'ping':
        if (hasId) this.reply(m.id, {});
        return;
      case 'ui/notifications/size-changed': {
        const h = Number(params.height);
        if (Number.isFinite(h) && h > 0) this.api.resize(Math.ceil(h));
        return;
      }
      case 'notifications/message':
        return;
      default:
        if (hasId) this.fail(m.id, -32601, `method not supported: ${m.method}`);
    }
  }
}
