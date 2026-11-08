// GET/PUT /api/issue-reporting — the "Share bug reports" switch and its status.
// POST /api/issue-reports — the Report a bug button: files one issue now.
//
// NO FALLBACK: a manual report that cannot be filed is a 502 with GitHub's
// reason, so the button can say so.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSurface } from './client-crash-routes.js';
import type { IssueFiler } from './issue-filer.js';
import type { Registry } from './registry.js';

const Toggle = z.object({ enabled: z.boolean() }).strict();

const Manual = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(4_000).default(''),
    surface: z.string().max(40).optional(),
    route: z.string().max(200).optional(),
    build: z.string().max(100).optional(),
    platform: z.string().max(100).optional(),
    /** Messages of the last errors the surface showed, so the report has context. */
    recentErrors: z.array(z.string().max(500)).max(10).default([]),
  })
  .strict();

export function registerIssueFilerRoutes(
  app: FastifyInstance,
  deps: { filer: IssueFiler; registry: Registry },
): void {
  app.get('/api/issue-reporting', async (req) => {
    await requireSurface(req, deps.registry);
    return deps.filer.status();
  });

  app.put('/api/issue-reporting', async (req, reply) => {
    await requireSurface(req, deps.registry);
    const parsed = Toggle.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    deps.filer.setEnabled(parsed.data.enabled);
    if (parsed.data.enabled) void deps.filer.flush().catch(() => undefined);
    return deps.filer.status();
  });

  app.post('/api/issue-reports', async (req, reply) => {
    await requireSurface(req, deps.registry);
    const parsed = Manual.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid report', issues: parsed.error.issues });
    }
    const b = parsed.data;
    const recent =
      b.recentErrors.length > 0
        ? `${b.description}\n\nRecent errors shown:\n${b.recentErrors.map((e) => `- ${e}`).join('\n')}`
        : b.description;
    try {
      const url = await deps.filer.fileManual({
        kind: 'manual',
        message: b.title,
        description: recent,
        surface: b.surface,
        route: b.route,
        build: b.build,
        platform: b.platform,
      });
      return { ok: true, url };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
