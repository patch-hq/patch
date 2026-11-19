// Linked chats (spec/04 § Provider switches, § Moving to another host).
//
//   POST /api/chats/:id/continue  {model?, hostId?, folder?}
//   POST /api/chats/:id/move      {hostId, folder}
//
// A chat keeps its provider and its host for its whole life. Switching
// provider, moving to another host, or carrying on after the provider's
// session is gone all start a NEW chat linked to the old one. These routes
// draft it: a server-owned new-chat draft (spec/14 § New chat drafts) naming
// the chat it continues, whose text is the drafted first message
// (`linked-chat.ts`). The surface opens it on the new-chat screen; the user
// reads, edits and sends it, and that send spawns the chat (`POST /api/chats`
// with `continuedFrom`), which is when the two are linked. Nothing is copied
// between hosts and no provider session is carried.
//
// This file also answers a host's start-up inventory (`folders.list`) with
// `host.reconciled`, after retiring any old copy a move before linked chats
// left on that host while it was offline.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { isReservedSpecialThread, type WireEvent } from '@patch/wire';
import type { ChatRegistry } from './chat-registry.js';
import type { ChatLogStore } from './chat-log-store.js';
import type { HostLink } from './host-link.js';
import type { Registry } from './registry.js';
import type { NewChatDraftStore, NewChatDraft } from './new-chat-drafts.js';
import { checkRegisteredHost, UNKNOWN_HOST_STATUS } from './host-addressing.js';
import { requireAuth } from './folder-routes.js';
import { draftLinkedMessage } from './linked-chat.js';

export interface ChatContinueRoutesDeps {
  logger: Logger;
  registry: Registry;
  hostLink: HostLink;
  chatRegistry: ChatRegistry;
  /** The server's record of every chat — the source the first message is drafted from. */
  chatLogStore: ChatLogStore;
  newChatDrafts: NewChatDraftStore;
  idGenerator: () => string;
  /** Wait for a host's answer to an owed retire. Injectable for tests. */
  stepTimeoutMs?: number;
}

const RETIRE_TIMEOUT_MS = 120_000;
const SERVER_SURFACE = '_server';

type Body = { model?: unknown; hostId?: unknown; folder?: unknown };
type Reply = { status: number; body: object };

export function registerChatContinueRoutes(
  app: FastifyInstance,
  deps: ChatContinueRoutesDeps,
): void {
  const hostLabel = (hostId: string): string => deps.registry.hostName(hostId) ?? hostId;

  /** Draft the linked chat for `chatId`, or say why not. */
  function draftFor(
    chatId: string,
    body: Body,
    opts: { requireTarget: boolean },
  ): Reply | { draft: NewChatDraft } {
    const chat = deps.chatRegistry.get(chatId);
    if (!chat) {
      return { status: 404, body: { error: 'chat_not_found', message: `no chat ${chatId}` } };
    }
    if (isReservedSpecialThread(chatId)) {
      // The Manager and Speakers change home and model in place (spec/06).
      return {
        status: 400,
        body: {
          error: 'special_thread',
          message:
            'The Manager and Speakers continue in place; change their home or model in Settings',
        },
      };
    }
    if (chat.continuedIn !== undefined) {
      return {
        status: 409,
        body: {
          error: 'already_continued',
          message: 'This chat already continues in a newer chat; carry on from that one',
          continuedIn: chat.continuedIn,
        },
      };
    }
    const { model, hostId, folder } = body;
    if (opts.requireTarget && (typeof hostId !== 'string' || hostId.length === 0)) {
      return {
        status: 400,
        body: { error: 'hostId_required', message: 'name the host to move it to' },
      };
    }
    if (hostId !== undefined && (typeof hostId !== 'string' || hostId.length === 0)) {
      return { status: 400, body: { error: 'invalid_host', message: 'hostId must be a host id' } };
    }
    if (
      (opts.requireTarget || folder !== undefined) &&
      (typeof folder !== 'string' || !folder.startsWith('/'))
    ) {
      return {
        status: 400,
        body: {
          error: 'folder_required',
          message: 'name the absolute folder it will run in on that host',
        },
      };
    }
    if (model !== undefined && (typeof model !== 'string' || model.length === 0)) {
      return { status: 400, body: { error: 'invalid_model', message: 'model must be a model id' } };
    }
    const target = (hostId as string | undefined) ?? chat.hostId;
    const targetFolder = (folder as string | undefined) ?? chat.folder;
    if (target !== chat.hostId) {
      const unknownHost = checkRegisteredHost(deps.registry, target);
      if (unknownHost) return { status: UNKNOWN_HOST_STATUS, body: unknownHost };
    }
    if (opts.requireTarget && target === chat.hostId && targetFolder === chat.folder) {
      return {
        status: 400,
        body: { error: 'same_folder', message: `this chat already runs in ${targetFolder}` },
      };
    }
    const targetModel = (model as string | undefined) ?? chat.model ?? undefined;
    const text = draftLinkedMessage({
      name: chat.name,
      folder: chat.folder,
      hostName: hostLabel(chat.hostId),
      model: chat.model,
      events: deps.chatLogStore.read(chatId, -1),
    });
    const id = `draft-linked-${deps.idGenerator()}`;
    deps.newChatDrafts.set({
      id,
      hostId: target,
      folder: targetFolder,
      text,
      ...(targetModel !== undefined ? { model: targetModel } : {}),
      continuedFrom: chatId,
    });
    const draft = deps.newChatDrafts.list().find((d) => d.id === id);
    /* v8 ignore next 3 -- set() of a non-blank draft always stores it. */
    if (!draft) {
      return { status: 500, body: { error: 'internal', message: 'the draft was not stored' } };
    }
    deps.logger.info(
      { chatId, draftId: id, hostId: target, folder: targetFolder, model: targetModel ?? null },
      'linked chat drafted',
    );
    return { draft };
  }

  async function route(
    req: FastifyRequest<{ Params: { id: string }; Body: Body }>,
    reply: FastifyReply,
    requireTarget: boolean,
  ): Promise<FastifyReply> {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const res = draftFor(req.params.id, req.body ?? {}, { requireTarget });
    if ('draft' in res) return reply.code(201).send({ draft: res.draft });
    return reply.code(res.status).send(res.body);
  }

  app.post<{ Params: { id: string }; Body: Body }>('/api/chats/:id/continue', (req, reply) =>
    route(req, reply, false),
  );
  app.post<{ Params: { id: string }; Body: Body }>('/api/chats/:id/move', (req, reply) =>
    route(req, reply, true),
  );

  // ---- start-up reconcile, and old copies owed a retire ----
  //
  // A move made before linked chats could take a chat over from the server's
  // copy while its old host was offline; that host was owed a `retire` of its
  // copy when it next connected. Nothing creates such a debt any more, but one
  // already recorded is still paid, so the old copy does not come back.
  const timeoutMs = deps.stepTimeoutMs ?? RETIRE_TIMEOUT_MS;
  const retiresPath = deps.registry.dataDir
    ? join(deps.registry.dataDir, 'pending-retires.json')
    : null;
  const pendingRetires = new Map<string, string>(loadPendingRetires());
  const pending = new Map<string, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();

  // Re-derivable bookkeeping: a corrupt file must not stop the server booting.
  function loadPendingRetires(): [string, string][] {
    if (!retiresPath || !existsSync(retiresPath)) return [];
    try {
      return Object.entries(
        JSON.parse(readFileSync(retiresPath, 'utf8')) as Record<string, string>,
      );
    } catch (err) {
      deps.logger.error(
        { err, path: retiresPath },
        'pending-retires.json is unreadable; starting with no owed retires',
      );
      return [];
    }
  }
  function savePendingRetires(): void {
    if (!retiresPath) return;
    const tmp = `${retiresPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(pendingRetires)));
    renameSync(tmp, retiresPath);
  }
  function retire(hostId: string, chatId: string): Promise<boolean> {
    const requestId = deps.idGenerator();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(false);
      }, timeoutMs);
      pending.set(requestId, { resolve, timer });
      deps.hostLink.sendTo(hostId, SERVER_SURFACE, {
        type: 'patch.chat_move.request',
        requestId,
        hostId,
        chatId,
        op: 'retire',
        force: true,
      });
    });
  }
  async function retirePending(hostId: string): Promise<void> {
    for (const [chatId, holder] of [...pendingRetires]) {
      if (holder !== hostId) continue;
      if (await retire(hostId, chatId)) {
        pendingRetires.delete(chatId);
        savePendingRetires();
        deps.logger.info({ chatId, hostId }, 'old copy of a moved chat retired');
      } else {
        deps.logger.error(
          { chatId, hostId },
          'the old host kept its copy of a moved chat; will retry when it next connects',
        );
      }
    }
  }
  deps.hostLink.onEvent((event: WireEvent) => {
    if (event.type === 'folders.list') {
      // The end of the host's start-up inventory. It holds its start-up work
      // until `host.reconciled` arrives, so that is sent even when a retire
      // failed — the failure is logged and retried next connect.
      void retirePending(event.hostId)
        .catch((err: unknown) =>
          deps.logger.error({ err, hostId: event.hostId }, 'retiring old copies failed'),
        )
        .then(() => {
          deps.hostLink.sendTo(event.hostId, SERVER_SURFACE, {
            type: 'host.reconciled',
            hostId: event.hostId,
          });
        });
      return;
    }
    if (event.type !== 'patch.chat_move.response') return;
    const w = pending.get(event.requestId);
    if (!w) return;
    pending.delete(event.requestId);
    clearTimeout(w.timer);
    // A host that no longer has the chat has nothing to retire.
    w.resolve(event.ok || event.error?.code === 'not_found');
  });
}
