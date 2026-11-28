// Finished chats → the Manager: what is waiting, and deliver now (spec/06 § Finished chats,
// `patch threads finished` / `send-finished`).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifySurfaceCredential } from '@patch/auth';
import type { Registry } from './registry.js';
import type { ManagerFinishedCollector } from './manager-finished.js';

async function requireAuth(req: FastifyRequest, registry: Registry): Promise<void> {
  const generic = (): Error & { statusCode?: number } => {
    const e = new Error('unauthenticated') as Error & { statusCode?: number };
    e.statusCode = 401;
    return e;
  };
  const account = registry.getAccount();
  if (!account) throw generic();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) throw generic();
  const jwt = authHeader.slice('Bearer '.length).trim();
  let claims;
  try {
    claims = await verifySurfaceCredential(jwt, { userPublicKey: account.userPublicKey });
  } catch {
    throw generic();
  }
  if (registry.isRevoked(claims.surface_id)) throw generic();
}

async function authOr401(
  req: FastifyRequest,
  reply: FastifyReply,
  registry: Registry,
): Promise<boolean> {
  try {
    await requireAuth(req, registry);
    return true;
  } catch (e) {
    await reply
      .code((e as Error & { statusCode?: number }).statusCode ?? 401)
      .send({ error: (e as Error).message });
    return false;
  }
}

export interface ManagerFinishedRoutesDeps {
  registry: Registry;
  collector: ManagerFinishedCollector;
}

export function registerManagerFinishedRoutes(
  app: FastifyInstance,
  deps: ManagerFinishedRoutesDeps,
): void {
  // What happened, named: nothing waiting, a delivery already in flight, sent
  // N chats, or refused with the reason. `sent` stays for older CLIs.
  app.post('/api/manager/finished/send-now', async (req, reply) => {
    if (!(await authOr401(req, reply, deps.registry))) return;
    const result = deps.collector.sendNow();
    return reply.code(200).send({ sent: result.outcome === 'sent', ...result });
  });

  // What is waiting and when the last delivery went (Settings → Manager, `patch threads finished`).
  app.get('/api/manager/finished', async (req, reply) => {
    if (!(await authOr401(req, reply, deps.registry))) return;
    return reply.code(200).send(deps.collector.status());
  });
}
