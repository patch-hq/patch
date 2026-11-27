// Views — the server half (spec/14 § Views). One store (`store.ts`), two callers:
//   1. Patch's own UI, with a surface bearer: list, read (cheaply, by `since`),
//      mark an item, send the marks to the agent, delete.
//   2. The agent's `patch_view_*` tools, which reach `POST /api/views/agent`
//      through the host's API relay: set (full copy), patch (small changes),
//      read (the document and the user's marks) and list.
//
// Send delivers the changed marks into the owning chat as a user turn over the
// host link. NO FALLBACK: a chat that is gone fails the send and the marks stay
// unsent.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { HostLink } from '../host-link.js';
import type { Registry } from '../registry.js';
import type { ChatRegistry } from '../chat-registry.js';
import { requireAuth } from '../folder-routes.js';
import type { PatchOp } from './jsonpatch.js';
import {
  TEMPLATES,
  ViewError,
  ViewStore,
  itemIds,
  type Template,
  type ViewRecord,
} from './store.js';

const BRIDGE_SURFACE_ID = 'views-bridge';

export interface ViewRoutesDeps {
  logger: Logger;
  hostLink: HostLink;
  registry: Registry;
  chatRegistry: ChatRegistry;
  viewsDir: string;
  idGenerator: () => string;
}

/** What a surface or the agent sees of a view. */
export function viewJson(v: ViewRecord): Record<string, unknown> {
  return {
    id: v.id,
    chatId: v.chatId,
    title: v.title,
    template: v.template,
    rev: v.rev,
    data: v.data,
    marks: v.marks,
    unsent: Object.values(v.marks).filter((m) => m.unsent).length,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

/** A view without its document: what lists show. */
function summary(v: ViewRecord): Record<string, unknown> {
  return {
    id: v.id,
    chatId: v.chatId,
    title: v.title,
    template: v.template,
    rev: v.rev,
    items: itemIds(v.template, v.data).length,
    unsent: Object.values(v.marks).filter((m) => m.unsent).length,
    updatedAt: v.updatedAt,
  };
}

function itemTitle(v: ViewRecord, id: string): string {
  const it = ((v.data as { items?: { id: string; title: string }[] }).items ?? []).find(
    (i) => i.id === id,
  );
  return it ? it.title : id;
}

/** The [View] message the agent reads. */
export function marksMessage(
  v: ViewRecord,
  sent: { itemId: string; mark: { verdict: string | null; note: string } }[],
): string {
  const lines = sent.map(({ itemId, mark }) => {
    const bits = [mark.verdict ?? (mark.note ? 'no verdict' : 'cleared')];
    if (mark.note) bits.push(`note: ${mark.note}`);
    return `- ${itemId} "${itemTitle(v, itemId)}": ${bits.join(' — ')}`;
  });
  return [
    `[View] "${v.title}" (view ${v.id}, rev ${v.rev}) — the user marked ${sent.length} item${sent.length === 1 ? '' : 's'}:`,
    ...lines,
    `Act on them, then change the view with patch_view_patch (or patch_view_set) so it shows where things stand.`,
  ].join('\n');
}

interface AgentBody {
  chatId?: string;
  op?: string;
  viewId?: string;
  title?: string;
  template?: string;
  data?: unknown;
  ops?: PatchOp[];
  baseRev?: number;
}

export function registerViewRoutes(app: FastifyInstance, deps: ViewRoutesDeps): void {
  const log = deps.logger;
  const store = new ViewStore(deps.viewsDir);

  const fail = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof ViewError) return reply.code(err.status).send({ error: err.message });
    log.error({ err: (err as Error).message, stack: (err as Error).stack }, 'views: unhandled');
    return reply.code(500).send({ error: (err as Error).message });
  };

  const authed = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    try {
      await requireAuth(req, deps.registry);
      return true;
    } catch (e) {
      reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: 'unauthenticated' });
      return false;
    }
  };

  app.get('/api/views', async (req, reply) => {
    if (!(await authed(req, reply))) return;
    const chatId = (req.query as { chatId?: string }).chatId;
    return {
      views: store
        .list()
        .filter((v) => !chatId || v.chatId === chatId)
        .map(summary),
    };
  });

  // `since` is the rev the caller already has; the answer is `{ rev, unchanged: true }` while it is current.
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/views/:id',
    async (req, reply) => {
      if (!(await authed(req, reply))) return;
      try {
        const v = store.mustGet(req.params.id);
        const since = Number(req.query.since);
        if (req.query.since !== undefined && since === v.rev) {
          return {
            rev: v.rev,
            unchanged: true,
            unsent: viewJson(v)['unsent'],
            updatedAt: v.updatedAt,
          };
        }
        return viewJson(v);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { itemId?: string; verdict?: 'yes' | 'no' | null; note?: string };
  }>('/api/views/:id/marks', async (req, reply) => {
    if (!(await authed(req, reply))) return;
    try {
      const b = req.body ?? {};
      if (typeof b.itemId !== 'string') throw new ViewError(400, 'itemId is required');
      if (
        b.verdict !== undefined &&
        b.verdict !== null &&
        b.verdict !== 'yes' &&
        b.verdict !== 'no'
      ) {
        throw new ViewError(400, 'verdict must be "yes", "no" or null');
      }
      if (b.note !== undefined && typeof b.note !== 'string')
        throw new ViewError(400, 'note must be a string');
      return viewJson(store.mark(req.params.id, b.itemId, { verdict: b.verdict, note: b.note }));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/api/views/:id/send', async (req, reply) => {
    if (!(await authed(req, reply))) return;
    try {
      const v = store.mustGet(req.params.id);
      const sent = store.takeUnsent(v.id, false);
      if (sent.length === 0) throw new ViewError(409, 'no changed marks to send');
      if (!deps.chatRegistry.get(v.chatId)) {
        throw new ViewError(502, `the chat this view belongs to (${v.chatId}) no longer exists`);
      }
      deps.hostLink.send(BRIDGE_SURFACE_ID, {
        type: 'chat.input',
        chatId: v.chatId,
        message: marksMessage(v, sent),
        localId: deps.idGenerator(),
        source: { kind: 'view', viewId: v.id },
      });
      store.takeUnsent(v.id, true);
      return { sent: sent.length, view: viewJson(store.mustGet(v.id)) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/views/:id', async (req, reply) => {
    if (!(await authed(req, reply))) return;
    try {
      store.remove(req.params.id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // The agent's calls, relayed from the host. The chat is named in the body by the host, never by the model.
  app.post<{ Body: AgentBody }>('/api/views/agent', async (req, reply) => {
    if (!(await authed(req, reply))) return;
    try {
      const b = req.body ?? {};
      if (!b.chatId) throw new ViewError(400, 'chatId is required');
      switch (b.op) {
        case 'set': {
          if (!b.title) throw new ViewError(400, 'title is required');
          if (!TEMPLATES.includes(b.template as Template)) {
            throw new ViewError(400, `template must be one of: ${TEMPLATES.join(', ')}`);
          }
          return viewJson(
            store.set({
              ...(b.viewId ? { id: b.viewId } : {}),
              chatId: b.chatId,
              title: b.title,
              template: b.template as Template,
              data: b.data,
            }),
          );
        }
        case 'patch': {
          if (!b.viewId) throw new ViewError(400, 'viewId is required');
          if (!Array.isArray(b.ops) || b.ops.length === 0)
            throw new ViewError(400, 'ops is required');
          return viewJson(store.patch(b.viewId, b.chatId, b.ops, b.baseRev));
        }
        case 'read': {
          if (!b.viewId) throw new ViewError(400, 'viewId is required');
          const v = store.mustGet(b.viewId);
          if (v.chatId !== b.chatId)
            throw new ViewError(400, `view "${v.id}" belongs to another chat`);
          return viewJson(v);
        }
        case 'list':
          return {
            views: store
              .list()
              .filter((v) => v.chatId === b.chatId)
              .map(summary),
          };
        default:
          throw new ViewError(400, 'op must be set, patch, read or list');
      }
    } catch (err) {
      return fail(reply, err);
    }
  });
}
