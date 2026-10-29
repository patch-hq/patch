// Server-side host-link bridge for `patch.api.request`: the CLI on a host
// host manages patch (settings, keys, accounts, hosts) through the host's
// link rather than a separately paired credential. The request is run against
// this server's own REST API as the account, for an allowlist of management
// paths only; the answer goes back to the host that asked.
//
// NO FALLBACK: a path outside the allowlist is refused with 403, never run.

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { mintSurfaceCredential } from '@patch/auth';
import { PatchApiRequestEvent, type WireEvent } from '@patch/wire';
import type { HostLink } from './host-link.js';
import type { Registry } from './registry.js';

const BRIDGE_SURFACE_ID = 'api-rpc-bridge';

/** Management endpoints a host's own CLI may call. */
const ALLOWED_PREFIXES = [
  '/api/settings',
  '/api/accounts',
  '/api/providers',
  '/api/hosts',
  '/api/models',
  '/api/folders',
  '/api/surfaces',
  '/api/jobs',
  '/api/hooks',
  '/api/threads',
];

export function isRelayablePath(path: string): boolean {
  if (!path.startsWith('/api/') || path.includes('..') || path.includes('//')) return false;
  const bare = path.split('?')[0]!;
  return ALLOWED_PREFIXES.some((p) => bare === p || bare.startsWith(p + '/'));
}

export interface AttachApiBridgeOptions {
  link: HostLink;
  app: FastifyInstance;
  registry: Registry;
  logger: Logger;
}

export function attachApiRpcBridge(opts: AttachApiBridgeOptions): () => void {
  const { link, app, registry, logger } = opts;
  return link.onEvent((event: WireEvent, fromHostId: string | null) => {
    if (event.type !== 'patch.api.request') return;
    if (fromHostId === null) {
      logger.error({ requestId: event.requestId }, 'api-rpc-bridge: no originating host; dropping');
      return;
    }
    const reply = (status: number, body?: unknown): void => {
      link.sendTo(fromHostId, BRIDGE_SURFACE_ID, {
        type: 'patch.api.response',
        requestId: event.requestId,
        status,
        ...(body !== undefined ? { body } : {}),
      });
    };
    const parsed = PatchApiRequestEvent.safeParse(event);
    if (!parsed.success)
      return reply(400, { error: 'invalid_input', message: parsed.error.message });
    const req = parsed.data;
    if (!isRelayablePath(req.path)) {
      return reply(403, {
        error: 'path_not_relayable',
        message: `${req.path} is not available through a host`,
      });
    }
    void (async () => {
      try {
        const key = registry.getAccountPrivateKey();
        if (!key)
          return reply(503, { error: 'no_account', message: 'the server has no account yet' });
        const jwt = await mintSurfaceCredential({
          userPrivateKey: key,
          surfaceId: `host-relay-${fromHostId}`,
          surfaceKind: 'terminal',
          label: 'host relay',
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        });
        const res = await app.inject({
          method: req.method,
          url: req.path,
          headers: { authorization: `Bearer ${jwt}` },
          ...(req.body !== undefined ? { payload: req.body as object } : {}),
        });
        let body: unknown = res.body;
        if (res.body.length > 0) {
          try {
            body = JSON.parse(res.body);
          } catch {
            // non-JSON answer: pass the text through
          }
        } else body = undefined;
        reply(res.statusCode, body);
      } catch (err) {
        logger.error({ err: (err as Error).message, path: req.path }, 'api-rpc-bridge: failed');
        reply(500, { error: 'internal', message: (err as Error).message });
      }
    })();
  });
}
