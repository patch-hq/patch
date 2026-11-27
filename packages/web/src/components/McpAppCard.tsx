// McpAppCard — an MCP App (SEP-1865) drawn under the tool call that produced it.
//
// Asks the chat's host whether the tool declares a UI template; if it does not
// the card is nothing at all (the ordinary tool row already says what ran). If
// it does, the template runs in a sandboxed frame with an opaque origin and
// talks to Patch through `McpAppBridge`: its buttons call tools on the same MCP
// server, or post a message into the chat as the user.
//
// NO FALLBACK: a template that will not load shows the error, not a blank frame.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { api, ApiError } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { sendMessage } from '../lib/sendQueue.js';
import { McpAppBridge, buildSrcdoc, parseMcpToolName, toCallToolResult } from '../lib/mcpApps.js';

interface Template {
  hasUi: boolean;
  html?: string;
  uiMeta?: Record<string, unknown>;
}

// One answer per (host, chat, server, tool): the same tool called ten times in a
// chat asks once. A rejected ask is not kept, so reopening the chat retries it.
const templates = new Map<string, Promise<Template>>();

function templateFor(
  hostId: string,
  chatId: string,
  server: string,
  tool: string,
): Promise<Template> {
  const key = `${hostId}\0${chatId}\0${server}\0${tool}`;
  let p = templates.get(key);
  if (!p) {
    p = api.mcpApp(hostId, { chatId, op: 'resource', server, tool }).then((r) => ({
      hasUi: r.hasUi === true,
      ...(r.html !== undefined ? { html: r.html } : {}),
      ...(r.uiMeta !== undefined ? { uiMeta: r.uiMeta } : {}),
    }));
    templates.set(key, p);
    p.catch(() => templates.delete(key));
  }
  return p;
}

const DEFAULT_HEIGHT = 240;
const MAX_HEIGHT = 900;

export function McpAppCard({
  chatId,
  call,
  result,
}: {
  chatId: string;
  call: { tool?: string; toolArgs?: unknown };
  result: { toolResult?: unknown; toolIsError?: boolean };
}): JSX.Element | null {
  const parsed = parseMcpToolName(call.tool);
  const hostId = useChatStore((s) => s.chats[chatId]?.hostId ?? '');
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'none' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; tpl: Template }
  >({ kind: 'loading' });

  const server = parsed?.server;
  const tool = parsed?.tool;
  useEffect(() => {
    if (!server || !tool || !hostId) return;
    let live = true;
    templateFor(hostId, chatId, server, tool).then(
      (tpl) => {
        if (live)
          setState(tpl.hasUi && tpl.html !== undefined ? { kind: 'ready', tpl } : { kind: 'none' });
      },
      (err: unknown) => {
        if (!live) return;
        const message =
          err instanceof ApiError ? `${err.message}${bodyMessage(err.body)}` : String(err);
        // A server that is simply not reachable for this chat is not an app problem.
        setState(
          err instanceof ApiError && (err.status === 404 || err.status === 503)
            ? { kind: 'none' }
            : { kind: 'error', message },
        );
      },
    );
    return () => {
      live = false;
    };
  }, [hostId, chatId, server, tool]);

  const stored = result.toolResult;
  const isError = result.toolIsError === true;
  const toolResult = useMemo(() => toCallToolResult(stored, isError), [stored, isError]);

  if (!parsed || state.kind === 'loading' || state.kind === 'none') return null;
  if (state.kind === 'error') {
    return (
      <div className="mcp-app mcp-app-error" data-testid="mcp-app-error" role="alert">
        {parsed.server} app: {state.message}
      </div>
    );
  }
  return (
    <McpAppFrame
      chatId={chatId}
      hostId={hostId}
      server={parsed.server}
      tool={parsed.tool}
      tpl={state.tpl}
      toolArgs={call.toolArgs}
      toolResult={toolResult}
    />
  );
}

function bodyMessage(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'message' in body) {
    return `: ${String((body as { message: unknown }).message)}`;
  }
  return '';
}

function McpAppFrame({
  chatId,
  hostId,
  server,
  tool,
  tpl,
  toolArgs,
  toolResult,
}: {
  chatId: string;
  hostId: string;
  server: string;
  tool: string;
  tpl: Template;
  toolArgs: unknown;
  toolResult: Record<string, unknown>;
}): JSX.Element {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [callError, setCallError] = useState<string | null>(null);
  const srcDoc = useMemo(() => buildSrcdoc(tpl.html ?? '', tpl.uiMeta), [tpl]);
  const bordered = tpl.uiMeta?.prefersBorder !== false;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    const bridge = new McpAppBridge(
      {
        callTool: async (name, args) => {
          setCallError(null);
          try {
            const r = await api.mcpApp(hostId, {
              chatId,
              op: 'call',
              server,
              tool: name,
              ...(args ? { arguments: args } : {}),
            });
            return r.result ?? {};
          } catch (err) {
            const message =
              err instanceof Error
                ? err.message + (err instanceof ApiError ? bodyMessage(err.body) : '')
                : String(err);
            setCallError(`${name}: ${message}`);
            throw new Error(message);
          }
        },
        sendMessage: (text) => {
          sendMessage(chatId, text, []);
        },
        openLink: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
        resize: (h) => setHeight(Math.min(MAX_HEIGHT, h)),
      },
      {
        toolInput:
          typeof toolArgs === 'object' && toolArgs !== null
            ? (toolArgs as Record<string, unknown>)
            : undefined,
        toolResult,
        theme: dark.matches ? 'dark' : 'light',
        locale: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      (msg) => frame.contentWindow?.postMessage(msg, '*'),
    );
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frame.contentWindow) return;
      bridge.receive(e.data);
    };
    const onTheme = (): void => bridge.setTheme(dark.matches ? 'dark' : 'light');
    window.addEventListener('message', onMessage);
    dark.addEventListener('change', onTheme);
    return () => {
      window.removeEventListener('message', onMessage);
      dark.removeEventListener('change', onTheme);
      bridge.teardown();
    };
    // The frame is bound to one template and one result; a new one remounts the card.
  }, [chatId, hostId, server, tool, toolArgs, toolResult]);

  return (
    <div
      className={`mcp-app${bordered ? ' mcp-app-bordered' : ''}`}
      data-testid="mcp-app"
      data-server={server}
    >
      <iframe
        ref={frameRef}
        className="mcp-app-frame"
        data-testid="mcp-app-frame"
        title={`${server} · ${tool}`}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        style={{ height }}
      />
      {callError ? (
        <div className="mcp-app-call-error" data-testid="mcp-app-call-error" role="alert">
          {callError}
        </div>
      ) : null}
    </div>
  );
}
