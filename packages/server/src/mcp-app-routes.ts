// MCP Apps REST (SEP-1865): the chat surface's way to a tool's UI template and
// to the tool calls that UI makes.
//
//   POST /api/hosts/:hostId/mcp-app  {chatId, op: 'resource'|'call', server, tool, arguments?}
//
// Auth and host checks are exactly host files': a live surface credential and
// a hostId this account registered. Each call round-trips one
// `patch.mcp_app.request` to that host. NO FALLBACK: an offline host is a 503,
// a timeout a 504, and every host refusal keeps its own status.

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';
import type { Registry } from './registry.js';
import type { HostLink } from './host-link.js';
import { checkRegisteredHost, UNKNOWN_HOST_STATUS } from './host-addressing.js';
import { requireAuth } from './folder-routes.js';

export interface McpAppRoutesDeps {
  logger: Logger;
  registry: Registry;
  hostLink: HostLink;
  idGenerator: () => string;
}

/** A tool can be slow (it may start a server first); still bounded. */
export const MCP_APP_TIMEOUT_MS = 130_000;

type Response = Extract<WireEvent, { type: 'patch.mcp_app.response' }>;
type ErrorCode = NonNullable<Response['error']>['code'];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  server_not_found: 404,
  tool_not_found: 404,
  not_app_visible: 403,
  bad_resource: 502,
  server_failed: 502,
};

export function registerMcpAppRoutes(app: FastifyInstance, deps: McpAppRoutesDeps): void {
  const pending = new Map<
    string,
    { resolve: (ev: Response) => void; timeout: NodeJS.Timeout; hostId: string }
  >();
  deps.hostLink.onEvent((event: WireEvent, from) => {
    if (event.type !== 'patch.mcp_app.response') return;
    const w = pending.get(event.requestId);
    if (!w) return;
    if (event.hostId !== w.hostId || (from !== null && from !== w.hostId)) {
      deps.logger.warn(
        { requestId: event.requestId, asked: w.hostId, answered: event.hostId, from },
        'mcp app: response from a host that was not asked; ignoring',
      );
      return;
    }
    pending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });

  app.post<{ Params: { hostId: string }; Body: Record<string, unknown> }>(
    '/api/hosts/:hostId/mcp-app',
    // A tool's arguments can carry form data; the default 1 MiB is enough, stated so.
    { bodyLimit: 1024 * 1024 },
    async (req, reply) => {
      let auth;
      try {
        auth = await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      const hostId = req.params.hostId;
      const unknownHost = checkRegisteredHost(deps.registry, hostId);
      if (unknownHost) return reply.code(UNKNOWN_HOST_STATUS).send(unknownHost);
      if (!deps.hostLink.isOnline(hostId)) {
        return reply
          .code(503)
          .send({ error: 'host_offline', message: `${hostId} is offline`, hostId });
      }
      const b = req.body ?? {};
      const args = b.arguments;
      const valid =
        typeof b.chatId === 'string' &&
        b.chatId !== '' &&
        (b.op === 'resource' || b.op === 'call') &&
        typeof b.server === 'string' &&
        b.server !== '' &&
        typeof b.tool === 'string' &&
        b.tool !== '' &&
        (args === undefined || (typeof args === 'object' && args !== null && !Array.isArray(args)));
      if (!valid) {
        return reply
          .code(400)
          .send({ error: 'bad_request', message: 'body needs chatId, op, server, tool' });
      }
      const requestId = deps.idGenerator();
      const result = await new Promise<Response | 'timeout'>((resolve) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          resolve('timeout');
        }, MCP_APP_TIMEOUT_MS);
        pending.set(requestId, { resolve, timeout, hostId });
        deps.hostLink.sendTo(hostId, auth.surfaceId, {
          type: 'patch.mcp_app.request',
          requestId,
          hostId,
          chatId: b.chatId as string,
          op: b.op as 'resource' | 'call',
          server: b.server as string,
          tool: b.tool as string,
          ...(args !== undefined ? { arguments: args as Record<string, unknown> } : {}),
        });
      });
      if (result === 'timeout') return reply.code(504).send({ error: 'daemon_timeout' });
      if (!result.ok) {
        const code = result.error?.code ?? 'server_failed';
        return reply
          .code(STATUS_BY_CODE[code])
          .send({ error: code, message: result.error?.message ?? 'mcp app error' });
      }
      return reply.code(200).send({
        hasUi: result.hasUi,
        html: result.html,
        uiMeta: result.uiMeta,
        result: result.result,
      });
    },
  );
}
