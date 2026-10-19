// Link summary REST route (spec/14 § Message links — the Summarise button).
//
// POST /api/link-summary {url} — fetches the linked page server-side (same
// SSRF-checked fetch as the link preview), then round-trips one
// `patch.link_summary.request` to the account's home machine, which holds the
// Claude credential and runs the account's `linkSummaryPrompt` over the page
// text. NO FALLBACK: an unfetchable page is a 4xx/502, an offline home machine
// is a 503, a timeout is a 504, and a failed model call is a 502 carrying its
// reason — never an empty summary.

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { SharedSettings, WireEvent } from '@patch/wire';
import type { Registry } from './registry.js';
import type { HostLink } from './host-link.js';
import { requireAuth } from './folder-routes.js';
import {
  extractReadableText,
  fetchChecked,
  isBlockedHost,
  RedirectRefused,
} from './link-preview-routes.js';

export interface LinkSummaryRoutesDeps {
  logger: Logger;
  registry: Registry;
  hostLink: HostLink;
  idGenerator: () => string;
  settings: () => SharedSettings;
}

const FETCH_TIMEOUT_MS = 10_000;
/** How much page text goes to the model — enough for an article, bounded for cost. */
export const LINK_SUMMARY_MAX_CHARS = 24_000;
/** Fetch + a model call. */
export const LINK_SUMMARY_TIMEOUT_MS = 60_000;

const Body = z.object({ url: z.string().min(1) }).strict();

type Response = Extract<WireEvent, { type: 'patch.link_summary.response' }>;

export function registerLinkSummaryRoutes(app: FastifyInstance, deps: LinkSummaryRoutesDeps): void {
  const pending = new Map<
    string,
    { resolve: (ev: Response) => void; timeout: NodeJS.Timeout; hostId: string }
  >();
  deps.hostLink.onEvent((event: WireEvent, from) => {
    if (event.type !== 'patch.link_summary.response') return;
    const w = pending.get(event.requestId);
    if (!w) return;
    if (event.hostId !== w.hostId || (from !== null && from !== w.hostId)) {
      deps.logger.warn(
        { requestId: event.requestId, asked: w.hostId, answered: event.hostId, from },
        'link summary: response from a machine that was not asked; ignoring',
      );
      return;
    }
    pending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });

  app.post('/api/link-summary', async (req, reply) => {
    let surfaceId: string;
    try {
      surfaceId = (await requireAuth(req, deps.registry)).surfaceId;
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_url', message: 'url is required' });
    }
    let target: URL;
    try {
      target = new URL(parsed.data.url.trim());
    } catch {
      return reply.code(400).send({ error: 'invalid_url', message: 'url is not a valid URL' });
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return reply
        .code(400)
        .send({ error: 'invalid_url', message: 'only http/https URLs are supported' });
    }
    if (isBlockedHost(target.hostname)) {
      return reply
        .code(400)
        .send({ error: 'blocked_host', message: 'this host cannot be summarised' });
    }
    const hostId = deps.registry.managerHostId();
    if (hostId === null || !deps.hostLink.isOnline(hostId)) {
      return reply.code(503).send({
        error: 'host_offline',
        message: hostId === null ? 'no machine is registered' : `${hostId} is offline`,
      });
    }

    let text: string;
    const controller = new AbortController();
    const fetchTimer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchChecked(
        target,
        {
          signal: controller.signal,
          headers: { accept: 'text/html', 'user-agent': 'Patch-LinkSummary/1.0' },
        },
        deps.logger,
      );
      if (!res.ok) {
        return reply.code(502).send({ error: 'fetch_failed', message: `upstream ${res.status}` });
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
        return reply
          .code(415)
          .send({ error: 'unsupported_content_type', message: contentType || 'unknown' });
      }
      const body = await res.text();
      text = contentType.includes('text/plain')
        ? body.replace(/\s+/g, ' ').trim()
        : extractReadableText(body);
    } catch (e) {
      if (e instanceof RedirectRefused) {
        return reply.code(e.status).send({ error: e.code, message: e.message });
      }
      deps.logger.warn(
        { url: target.toString(), err: (e as Error).message },
        'link-summary fetch failed',
      );
      return reply.code(502).send({ error: 'fetch_failed', message: (e as Error).message });
    } finally {
      clearTimeout(fetchTimer);
    }
    if (text === '') {
      return reply
        .code(422)
        .send({ error: 'no_text', message: 'the page has no readable text to summarise' });
    }

    const requestId = deps.idGenerator();
    const result = await new Promise<Response | 'timeout'>((resolve) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        resolve('timeout');
      }, LINK_SUMMARY_TIMEOUT_MS);
      pending.set(requestId, { resolve, timeout, hostId });
      deps.hostLink.sendTo(hostId, surfaceId, {
        type: 'patch.link_summary.request',
        requestId,
        hostId,
        prompt: deps.settings().linkSummaryPrompt,
        url: target.toString(),
        text: text.slice(0, LINK_SUMMARY_MAX_CHARS),
      });
    });
    if (result === 'timeout') return reply.code(504).send({ error: 'daemon_timeout' });
    if (!result.ok || result.summary === undefined) {
      return reply.code(502).send({
        error: 'summary_failed',
        message: result.error ?? 'the host returned no summary',
      });
    }
    return reply.code(200).send({ url: target.toString(), summary: result.summary });
  });
}
