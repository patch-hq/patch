// Replacing a host (spec/11 § Replacing a host; decisions 4 and 12).
//
//   GET  /api/hosts/:hostId/replace?with=<newHostId>
//        → 200 the plan: the old host's chats, the folders they use and whether
//          each is on the new host, and where the provider session files are
//   POST /api/hosts/:hostId/replace  {with, withoutFolders?}
//        → 200 {ok, moved, withoutFolders, hosts}
//        | 409 folders_missing {missing}   (a missing folder the user did not confirm)
//        | 502 chats_not_taken {refused}   (the old host stays; nothing is lost)
//
// Both refuse 404 unknown_host, 400 with_required / same_host, 409 manager_home
// (the Manager never moves by itself: the user changes its home first) and
// 503 host_offline when the new host is not connected; a host that does not
// answer is 504.
//
// A chat lives on one host for its whole life; this is the one deliberate step
// that changes which host that is. The new host checks it has every folder the
// old host's chats use and names any it does not. On confirming, the server
// hands the new host every chat of the old one, each continuing from the
// server's high-water mark under the same id; the chats are rebound to the new
// host, the messages held for the old host go to the new one, and the old host
// is removed from the account. The user carries the folders and the provider
// session files across; Patch never edits them. A chat whose session did not
// come stays readable and starts a fresh session at its next turn, saying so.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import {
  isReservedSpecialThread,
  type AdoptedChat,
  type AuthOkHost,
  type ChatStateEvent,
  type WireEvent,
} from '@patch/wire';
import type { Registry } from './registry.js';
import type { HostLink } from './host-link.js';
import type { ChatRegistry, ChatSummary } from './chat-registry.js';
import type { ChatLogStore } from './chat-log-store.js';
import { checkRegisteredHost, UNKNOWN_HOST_STATUS } from './host-addressing.js';
import { requireAuth } from './folder-routes.js';

export interface HostReplaceRoutesDeps {
  logger: Logger;
  registry: Registry;
  hostLink: HostLink;
  chatRegistry: ChatRegistry;
  chatLogStore: ChatLogStore;
  idGenerator: () => string;
  broadcastChatState: (state: ChatStateEvent) => void;
  /** Revoke the host and forget it everywhere, as `DELETE /api/hosts/:hostId` does. */
  removeHost: (hostId: string, by: string) => void;
  hosts: () => AuthOkHost[];
  /** How long a host has to answer. Injectable for tests. */
  timeoutMs?: number;
}

export const HOST_REPLACE_TIMEOUT_MS = 60_000;
const SERVER_SURFACE = '_server';

/** Where each provider keeps a chat's session files on a host (spec/11 § Replacing a host). */
export function sessionFilesPath(harness: string, chatId: string): string {
  if (harness === 'claude') return `~/.patch/chats/${chatId}/claude`;
  if (harness === 'codex') return '~/.patch/openai/<account>/sessions';
  return `wherever ${harness} keeps its sessions`;
}

type Reply = { status: number; body: object };
type Plan = {
  from: { hostId: string; name: string };
  to: { hostId: string; name: string };
  chats: number;
  folders: Array<{ folder: string; chats: number; present: boolean }>;
  missing: string[];
  sessions: Array<{ provider: string; path: string; chats: number }>;
};

export function registerHostReplaceRoutes(app: FastifyInstance, deps: HostReplaceRoutesDeps): void {
  const timeoutMs = deps.timeoutMs ?? HOST_REPLACE_TIMEOUT_MS;
  const pending = new Map<string, { resolve: (e: WireEvent) => void; timer: NodeJS.Timeout }>();
  deps.hostLink.onEvent((event) => {
    if (event.type !== 'patch.folders_check.response' && event.type !== 'patch.chat_adopt.response')
      return;
    const w = pending.get(event.requestId);
    if (!w) return;
    pending.delete(event.requestId);
    clearTimeout(w.timer);
    w.resolve(event);
  });

  function ask(hostId: string, event: WireEvent & { requestId: string }): Promise<WireEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(event.requestId);
        reject(new Error(`${label(hostId)} did not answer within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      pending.set(event.requestId, { resolve, timer });
      deps.hostLink.sendTo(hostId, SERVER_SURFACE, event);
    });
  }

  const label = (hostId: string): string => deps.registry.hostName(hostId) ?? hostId;

  /** The chats a replacement moves: every chat of the old host but the special threads. */
  const chatsOf = (hostId: string): ChatSummary[] =>
    deps.chatRegistry.chatsOnHost(hostId).filter((c) => !isReservedSpecialThread(c.chatId));

  function refuse(fromHostId: string, toHostId: unknown): Reply | null {
    for (const id of [fromHostId, toHostId]) {
      if (typeof id !== 'string' || id === '') {
        return {
          status: 400,
          body: { error: 'with_required', message: 'name the host that replaces it' },
        };
      }
      const unknown = checkRegisteredHost(deps.registry, id);
      if (unknown) return { status: UNKNOWN_HOST_STATUS, body: unknown };
    }
    if (fromHostId === toHostId) {
      return {
        status: 400,
        body: { error: 'same_host', message: 'a host cannot replace itself' },
      };
    }
    if (deps.registry.managerHostId() === fromHostId) {
      return {
        status: 409,
        body: {
          error: 'manager_home',
          message: `${label(fromHostId)} is the Manager's home. Choose a new home in Settings → Manager first.`,
        },
      };
    }
    if (!deps.hostLink.isOnline(toHostId as string)) {
      return {
        status: 503,
        body: {
          error: 'host_offline',
          message: `${label(toHostId as string)} is offline; it has to be connected to check its folders`,
        },
      };
    }
    return null;
  }

  async function plan(fromHostId: string, toHostId: string): Promise<Plan> {
    const chats = chatsOf(fromHostId);
    const byFolder = new Map<string, number>();
    for (const c of chats) byFolder.set(c.folder, (byFolder.get(c.folder) ?? 0) + 1);
    const folders = [...byFolder.keys()].sort();
    const answer = await ask(toHostId, {
      type: 'patch.folders_check.request',
      requestId: deps.idGenerator(),
      hostId: toHostId,
      folders,
    });
    const missing = answer.type === 'patch.folders_check.response' ? answer.missing : folders;
    const missingSet = new Set(missing);
    const sessions = new Map<string, { provider: string; path: string; chats: number }>();
    for (const c of chats) {
      const ref = deps.chatLogStore.lastNativeRef(c.chatId);
      if (!ref) continue;
      const path = sessionFilesPath(ref.harness, c.chatId);
      const key = ref.harness === 'claude' ? 'claude' : `${ref.harness}:${path}`;
      const held = sessions.get(key);
      if (held) held.chats++;
      else
        sessions.set(key, {
          provider: ref.harness,
          path: ref.harness === 'claude' ? '~/.patch/chats/<chat id>/claude' : path,
          chats: 1,
        });
    }
    return {
      from: { hostId: fromHostId, name: label(fromHostId) },
      to: { hostId: toHostId, name: label(toHostId) },
      chats: chats.length,
      folders: folders.map((folder) => ({
        folder,
        chats: byFolder.get(folder) ?? 0,
        present: !missingSet.has(folder),
      })),
      missing: [...missing].sort(),
      sessions: [...sessions.values()],
    };
  }

  async function authed(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    try {
      return (await requireAuth(req, deps.registry)).surfaceId;
    } catch (e) {
      await reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
      return null;
    }
  }

  app.get<{ Params: { hostId: string }; Querystring: { with?: string } }>(
    '/api/hosts/:hostId/replace',
    async (req, reply) => {
      if ((await authed(req, reply)) === null) return reply;
      const { hostId } = req.params;
      const refused = refuse(hostId, req.query.with);
      if (refused) return reply.code(refused.status).send(refused.body);
      try {
        return await plan(hostId, req.query.with as string);
      } catch (err) {
        return reply.code(504).send({ error: 'host_timeout', message: (err as Error).message });
      }
    },
  );

  app.post<{
    Params: { hostId: string };
    Body: { with?: unknown; withoutFolders?: unknown } | undefined;
  }>('/api/hosts/:hostId/replace', async (req, reply) => {
    const by = await authed(req, reply);
    if (by === null) return reply;
    const fromHostId = req.params.hostId;
    const toHostId = req.body?.with;
    const refused = refuse(fromHostId, toHostId);
    if (refused) return reply.code(refused.status).send(refused.body);
    const to = toHostId as string;
    const without = Array.isArray(req.body?.withoutFolders)
      ? (req.body.withoutFolders as unknown[]).filter((f): f is string => typeof f === 'string')
      : [];

    let checked: Plan;
    try {
      checked = await plan(fromHostId, to);
    } catch (err) {
      return reply.code(504).send({ error: 'host_timeout', message: (err as Error).message });
    }
    const unconfirmed = checked.missing.filter((f) => !without.includes(f));
    if (unconfirmed.length > 0) {
      return reply.code(409).send({
        error: 'folders_missing',
        message: `${checked.to.name} does not have ${unconfirmed.length === 1 ? 'this folder' : 'these folders'}: ${unconfirmed.join(', ')}`,
        missing: unconfirmed,
      });
    }

    const chats = chatsOf(fromHostId);
    const adopt: AdoptedChat[] = chats.map((c) => {
      const ref = deps.chatLogStore.lastNativeRef(c.chatId);
      return {
        chatId: c.chatId,
        folder: c.folder,
        name: c.name,
        ...(c.model ? { model: c.model } : {}),
        permissionMode: c.permissionMode,
        ...(ref ? { sessionId: ref.sessionId } : {}),
        nextSeq: deps.chatLogStore.highWater(c.chatId) + 1,
        status: c.status,
        pinned: c.pinned,
        ...(c.createdAt !== undefined ? { createdAt: c.createdAt } : {}),
      };
    });
    let answer: WireEvent;
    try {
      answer = await ask(to, {
        type: 'patch.chat_adopt.request',
        requestId: deps.idGenerator(),
        hostId: to,
        chats: adopt,
      });
    } catch (err) {
      return reply.code(504).send({ error: 'host_timeout', message: (err as Error).message });
    }
    if (answer.type !== 'patch.chat_adopt.response') throw new Error('unreachable');

    // Each chat the new host now holds is its chat from here on.
    const byId = new Map(chats.map((c) => [c.chatId, c]));
    for (const chatId of answer.adopted) {
      const row = byId.get(chatId);
      if (!row) continue;
      const state = deps.chatRegistry.rehome(chatId, to, row.folder);
      if (state) deps.broadcastChatState(state);
    }
    if (answer.refused.length > 0) {
      deps.logger.error(
        { fromHostId, toHostId: to, refused: answer.refused },
        'replace host: the new host did not take every chat; the old host stays',
      );
      return reply.code(502).send({
        error: 'chats_not_taken',
        message: `${checked.to.name} could not take ${answer.refused.length} of ${chats.length} chats; ${checked.from.name} stays until they move`,
        refused: answer.refused,
        moved: answer.adopted.length,
      });
    }

    const held = deps.hostLink.handOverHeld(fromHostId, to);
    deps.removeHost(fromHostId, by);
    deps.logger.info(
      { fromHostId, toHostId: to, moved: answer.adopted.length, held, without },
      'host replaced',
    );
    return {
      ok: true,
      moved: answer.adopted.length,
      withoutFolders: checked.missing,
      hosts: deps.hosts(),
    };
  });
}
