// Voiceprints for enrolment (spec/16 § Who is speaking, spec/03 § Voiceprints).
//
//   POST /api/voice/voiceprint      {pcm}  a recorded sample's voiceprint
//   GET  /api/voice/recent-voices          the voices devices heard lately
//
// Both round-trip one `patch.voiceprint.request` to the Manager's home host:
// device conversations run there, so that is where the voices were heard, and
// it is a host with the voice component. The server only relays; the profile
// itself is written by Settings through the shared settings like any other.
// NO FALLBACK: no home host, or an offline one, is a 503 saying so.

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';
import type { Registry } from './registry.js';
import type { HostLink } from './host-link.js';
import { requireAuth } from './folder-routes.js';

export interface VoiceprintRoutesDeps {
  logger: Logger;
  registry: Registry;
  hostLink: HostLink;
  idGenerator: () => string;
  /** The Manager's home host, if one is set. */
  homeHostId: () => string | null;
}

/** A voiceprint takes a fraction of a second; loading the model the first time, a few. */
export const VOICEPRINT_TIMEOUT_MS = 20_000;

/** Up to 30 s of 16 kHz PCM16, base64. */
export const VOICEPRINT_BODY_LIMIT = 2 * 1024 * 1024;

type Response = Extract<WireEvent, { type: 'patch.voiceprint.response' }>;
type ErrorCode = NonNullable<Response['error']>['code'];
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  too_short: 400,
  voice_component_missing: 503,
  internal: 502,
};

export function registerVoiceprintRoutes(app: FastifyInstance, deps: VoiceprintRoutesDeps): void {
  const pending = new Map<
    string,
    { resolve: (ev: Response) => void; timeout: NodeJS.Timeout; hostId: string }
  >();
  deps.hostLink.onEvent((event: WireEvent, from) => {
    if (event.type !== 'patch.voiceprint.response') return;
    const w = pending.get(event.requestId);
    if (!w) return;
    if (event.hostId !== w.hostId || (from !== null && from !== w.hostId)) {
      deps.logger.warn(
        { requestId: event.requestId, asked: w.hostId, answered: event.hostId, from },
        'voiceprint: response from a host that was not asked; ignoring',
      );
      return;
    }
    pending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });

  async function roundTrip(
    surfaceId: string,
    body: { op: 'embed'; pcm: string } | { op: 'recent' },
  ): Promise<{ status: number; payload: unknown }> {
    const hostId = deps.homeHostId();
    if (hostId === null) {
      return {
        status: 503,
        payload: {
          error: 'no_home_host',
          message: 'No host is home to the Manager, so no voice device is running.',
        },
      };
    }
    if (!deps.hostLink.isOnline(hostId)) {
      return {
        status: 503,
        payload: { error: 'host_offline', message: `${hostId} is offline`, hostId },
      };
    }
    const requestId = deps.idGenerator();
    const result = await new Promise<Response | 'timeout'>((resolve) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        resolve('timeout');
      }, VOICEPRINT_TIMEOUT_MS);
      pending.set(requestId, { resolve, timeout, hostId });
      deps.hostLink.sendTo(hostId, surfaceId, {
        type: 'patch.voiceprint.request',
        requestId,
        hostId,
        ...body,
      });
    });
    if (result === 'timeout') return { status: 504, payload: { error: 'daemon_timeout' } };
    if (!result.ok) {
      const code = result.error?.code ?? 'internal';
      return {
        status: STATUS_BY_CODE[code],
        payload: { error: code, message: result.error?.message ?? 'voiceprint failed' },
      };
    }
    return {
      status: 200,
      payload:
        body.op === 'embed'
          ? { voiceprint: result.voiceprint, seconds: result.seconds }
          : { recent: result.recent ?? [] },
    };
  }

  app.post<{ Body: { pcm?: unknown } }>(
    '/api/voice/voiceprint',
    { bodyLimit: VOICEPRINT_BODY_LIMIT },
    async (req, reply) => {
      let auth;
      try {
        auth = await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      const pcm = req.body?.pcm;
      if (typeof pcm !== 'string' || pcm.length === 0) {
        return reply
          .code(400)
          .send({ error: 'invalid_input', message: 'pcm (base64 PCM16 at 16 kHz) is required' });
      }
      const r = await roundTrip(auth.surfaceId, { op: 'embed', pcm });
      return reply.code(r.status).send(r.payload);
    },
  );

  app.get('/api/voice/recent-voices', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const r = await roundTrip(auth.surfaceId, { op: 'recent' });
    return reply.code(r.status).send(r.payload);
  });
}
