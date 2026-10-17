// Client crash reports.
//
// POST /api/client-crashes — a surface (the phone) reports a JS error caught by
// its chat-screen error boundary / global handler, or a native crash it found
// on the next launch. GET /api/client-crashes — read the stored reports back.
//
// Reports are appended to `<dataDir>/client-crashes.jsonl` and logged at error
// level, so they are readable from both the file and the server log. A crash
// that happened on a phone otherwise leaves no text anywhere the developer can
// reach.
//
// NO FALLBACK: a malformed report is a 400, an unwritable store is a 500.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { verifySurfaceCredential } from '@patch/auth';
import type { Registry } from './registry.js';

const ClientCrashBody = z
  .object({
    /** Where it was caught: error boundary, global JS handler, or native. */
    source: z.enum(['boundary', 'global', 'native']),
    message: z.string().max(4_000),
    stack: z.string().max(32_000).optional(),
    componentStack: z.string().max(32_000).optional(),
    chatId: z.string().max(200).optional(),
    route: z.string().max(500).optional(),
    fatal: z.boolean().optional(),
    build: z.string().max(200).optional(),
    /** Epoch ms the crash happened on the device. */
    occurredAt: z.number().int().nonnegative(),
  })
  .strict();

export type ClientCrashReport = z.infer<typeof ClientCrashBody>;

export interface StoredClientCrash extends ClientCrashReport {
  receivedAt: number;
  surfaceId: string;
}

export interface ClientCrashRoutesDeps {
  logger: Logger;
  registry: Registry;
  /** Where `client-crashes.jsonl` lives. */
  dataDir: string;
}

function unauthenticated(): Error & { statusCode?: number } {
  const e = new Error('unauthenticated') as Error & { statusCode?: number };
  e.statusCode = 401;
  return e;
}

async function requireSurface(req: FastifyRequest, registry: Registry): Promise<string> {
  const account = registry.getAccount();
  const authHeader = req.headers.authorization;
  if (!account || !authHeader || !authHeader.startsWith('Bearer ')) throw unauthenticated();
  try {
    const claims = await verifySurfaceCredential(authHeader.slice('Bearer '.length).trim(), {
      userPublicKey: account.userPublicKey,
    });
    if (registry.isRevoked(claims.surface_id)) throw unauthenticated();
    return claims.surface_id;
  } catch {
    throw unauthenticated();
  }
}

export function registerClientCrashRoutes(app: FastifyInstance, deps: ClientCrashRoutesDeps): void {
  const file = join(deps.dataDir, 'client-crashes.jsonl');

  app.post('/api/client-crashes', async (req, reply) => {
    const surfaceId = await requireSurface(req, deps.registry);
    const parsed = ClientCrashBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid crash report', issues: parsed.error.issues });
    }
    const stored: StoredClientCrash = { ...parsed.data, receivedAt: Date.now(), surfaceId };
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(stored)}\n`);
    deps.logger.error({ clientCrash: stored }, 'client crash reported');
    return { ok: true };
  });

  app.get('/api/client-crashes', async (req) => {
    await requireSurface(req, deps.registry);
    if (!existsSync(file)) return { crashes: [] as StoredClientCrash[] };
    const crashes = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as StoredClientCrash);
    return { crashes };
  });
}
