// Real-screen captures (agents can't see real Patch otherwise).
//
// A surface (web today) posts what it is showing: a screenshot where it can
// take one, and the page's markup and stylesheet where it has them. An agent
// reads the newest back through `patch_capture_screen` (the pad bridge's
// `capture` op) as files it can open and build a design from.
//
// POST /api/captures — surface bearer; stores one capture.
// Stored under `<dir>/<id>/` as meta.json plus the files; only the newest
// MAX_CAPTURES are kept. NO FALLBACK: an invalid body is a 400, an empty store
// is an error to the agent, never a made-up screen.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Registry } from './registry.js';
import { requireSurface } from './client-crash-routes.js';

export const MAX_CAPTURES = 20;
const MAX_FILE_CHARS = 12 * 1024 * 1024;

export const CaptureBody = z
  .object({
    surface: z.enum(['web', 'phone']),
    /** Where in the app the screen was (route or screen name). */
    route: z.string().max(500),
    viewport: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .strict(),
    /** Base64 PNG of the screen, when the surface could take one. */
    png: z.string().max(MAX_FILE_CHARS).optional(),
    /** The whole page as one self-contained HTML file (styles and fonts inlined). */
    html: z.string().max(MAX_FILE_CHARS).optional(),
    /** The page's computed stylesheet text. */
    css: z.string().max(MAX_FILE_CHARS).optional(),
  })
  .strict()
  .refine((b) => b.png !== undefined || b.html !== undefined, {
    message: 'a capture needs a screenshot (png) or markup (html)',
  });
export type CaptureBody = z.infer<typeof CaptureBody>;

export interface CaptureMeta {
  id: string;
  surface: 'web' | 'phone';
  route: string;
  viewport: { width: number; height: number };
  takenAt: number;
  files: string[];
}

export class CaptureError extends Error {
  override readonly name = 'CaptureError';
}

export class CaptureStore {
  constructor(private readonly dir: string) {}

  add(body: CaptureBody, now = Date.now()): CaptureMeta {
    const id = `cap_${now.toString(36)}${randomBytes(3).toString('hex')}`;
    const root = join(this.dir, id);
    mkdirSync(root, { recursive: true });
    const files: string[] = [];
    const put = (name: string, data: Buffer): void => {
      writeFileSync(join(root, name), data);
      files.push(name);
    };
    if (body.png !== undefined) put('screen.png', Buffer.from(body.png, 'base64'));
    if (body.html !== undefined) put('page.html', Buffer.from(body.html, 'utf8'));
    if (body.css !== undefined) put('real.css', Buffer.from(body.css, 'utf8'));
    const meta: CaptureMeta = {
      id,
      surface: body.surface,
      route: body.route,
      viewport: body.viewport,
      takenAt: now,
      files,
    };
    writeFileSync(join(root, 'meta.json'), JSON.stringify(meta));
    this.prune();
    return meta;
  }

  list(): CaptureMeta[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .map((id) => JSON.parse(readFileSync(join(this.dir, id, 'meta.json'), 'utf8')) as CaptureMeta)
      .sort((a, b) => b.takenAt - a.takenAt);
  }

  /** The newest capture, optionally of one surface; throws when there is none. */
  latest(surface?: 'web' | 'phone'): {
    meta: CaptureMeta;
    files: { path: string; base64: string }[];
  } {
    const meta = this.list().find((m) => surface === undefined || m.surface === surface);
    if (!meta) {
      const which = surface ? `${surface} ` : '';
      throw new CaptureError(
        `no ${which}capture yet: ask the user to run "Capture this screen" in Patch (web: ⌘⇧K) and try again`,
      );
    }
    const files = meta.files.map((path) => ({
      path,
      base64: readFileSync(join(this.dir, meta.id, path)).toString('base64'),
    }));
    return { meta, files };
  }

  private prune(): void {
    for (const m of this.list().slice(MAX_CAPTURES)) {
      rmSync(join(this.dir, m.id), { recursive: true, force: true });
    }
  }
}

export function registerCaptureRoutes(
  app: FastifyInstance,
  deps: { registry: Registry; store: CaptureStore },
): void {
  app.post('/api/captures', { bodyLimit: 40 * 1024 * 1024 }, async (req, reply) => {
    await requireSurface(req, deps.registry);
    const parsed = CaptureBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid capture', issues: parsed.error.issues });
    }
    const meta = deps.store.add(parsed.data);
    return { id: meta.id };
  });
}
