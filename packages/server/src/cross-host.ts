// Cross-chat tools across machines (spec/03 § Cross-chat tools).
//
// "A cross-chat call whose target is on the calling chat's own host is
// short-circuited in-process. One naming another host goes over these frames,
// relayed by the server to that host."
//
// Jobs living here:
//
//   1. `patch.spawn` naming a machine OTHER than the one that raised it is
//      relayed to that machine's host, which creates the chat there, and that
//      machine's `patch.spawn.response` is relayed BACK to the caller — the
//      calling agent is blocked on it inside its turn, so a refusal there has
//      to arrive here rather than only in the target's log. A frame naming the
//      raising machine is its own audit record and is NOT relayed (that would
//      spawn the chat twice).
//   2. `patch.list_chats.request` is answered from the server's chat mirror,
//      because only the server sees every machine's chats. Each entry names the
//      machine it lives on, so the calling agent can address it afterwards.
//   2b. `patch.search_chats.request` is answered by `chat-search.ts` from the
//      chat mirror and the transcripts the server holds.
//   3. `patch.peek.request` / `patch.history.request` / `patch.send_to` carrying
//      a `requestId` are relayed to whichever machine the chat mirror says OWNS
//      `targetChatId` — resolved here rather than by the caller naming a host,
//      because `patch_peek`/`patch_history`/`patch_send_to` take only a chatId
//      (an agent learns which chat lives where from `patch_list_chats`, not the
//      other way round). The owning machine's `.response` is relayed back the
//      same way a spawn's is. A request with no `requestId` is a same-host call
//      already resolved in-process, kept on the wire only as an audit record,
//      and is never relayed (mirrors `patch.spawn`'s own-host case).
//
// NO FALLBACK: a call naming an unregistered or offline machine, or a chatId no
// machine has ever reported, is refused with an error naming the problem,
// returned to the CALLING machine so the tool call resolves inside the turn
// rather than hanging.

import type { Logger } from 'pino';
import { OUT_OF_BAND_SEQ, type ChatErrorCode, type WireEvent } from '@patch/wire';
import type { HostLink } from './host-link.js';
import type { ChatRegistry } from './chat-registry.js';
import type { Registry } from './registry.js';
import type { ActivityReader } from './activity.js';
import type { ChatLogStore } from './chat-log-store.js';
import { searchChats } from './chat-search.js';

/** Surface id used for server-originated frames on the host link. */
const BRIDGE_SURFACE_ID = 'cross-host-bridge';

export interface CrossHostBridgeDeps {
  logger: Logger;
  hostLink: HostLink;
  chatRegistry: ChatRegistry;
  registry: Registry;
  activity: ActivityReader;
  chatLogStore: ChatLogStore;
}

/**
 * How long the server remembers which machine asked for a relayed call.
 * Comfortably longer than the host's own wait on any of these, so the entry
 * outlives the call it belongs to and is only ever dropped as garbage.
 */
const RELAY_ROUTE_TTL_MS = 60_000;

export function registerCrossHostBridge(deps: CrossHostBridgeDeps): () => void {
  const { logger, hostLink, chatRegistry, registry, activity, chatLogStore } = deps;

  /**
   * requestId → the machine that raised a relayed `patch.spawn`, so its
   * answer goes back to the CALLER rather than being looked up from the chat
   * mirror (which can lag a freshly-spawned chat).
   */
  const spawnRoutes = new Map<string, { fromHostId: string; timer: NodeJS.Timeout }>();

  /**
   * requestId → the machine that raised a relayed `patch.peek.request` /
   * `patch.history.request` / `patch.send_to`. One map for all three: their
   * requestIds come from independent generators on the host side, so
   * collision would need two coordinators to mint the same random string.
   */
  const relayRoutes = new Map<string, { fromHostId: string; timer: NodeJS.Timeout }>();

  const trackRelay = (requestId: string, fromHostId: string): void => {
    const timer = setTimeout(() => relayRoutes.delete(requestId), RELAY_ROUTE_TTL_MS);
    timer.unref();
    relayRoutes.set(requestId, { fromHostId, timer });
  };

  const takeRelay = (requestId: string): { fromHostId: string } | undefined => {
    const route = relayRoutes.get(requestId);
    if (!route) return undefined;
    clearTimeout(route.timer);
    relayRoutes.delete(requestId);
    return route;
  };

  /**
   * Where does `targetChatId` actually live, and can it be reached right now?
   * The only place that knows is the chat mirror — `patch_peek`/`patch_history`/
   * `patch_send_to` are handed a bare chatId, never a host.
   */
  const resolveTargetHost = (
    targetChatId: string,
  ): { ok: true; hostId: string } | { ok: false; code: ChatErrorCode; message: string } => {
    const owner = chatRegistry.get(targetChatId);
    if (!owner) {
      return { ok: false, code: 'chat_not_found', message: `no such chat: ${targetChatId}` };
    }
    if (!hostLink.isOnline(owner.hostId)) {
      return {
        ok: false,
        code: 'host_not_registered',
        message: `machine ${owner.hostId}, which owns chat ${targetChatId}, is offline`,
      };
    }
    return { ok: true, hostId: owner.hostId };
  };

  const refuse = (
    fromHostId: string,
    chatId: string,
    code: ChatErrorCode,
    message: string,
  ): void => {
    hostLink.sendTo(fromHostId, BRIDGE_SURFACE_ID, {
      type: 'chat.error',
      chatId,
      error: { code, message },
      seq: OUT_OF_BAND_SEQ,
    });
  };

  /**
   * Answer a relayed spawn the server itself refused. The caller is BLOCKED on
   * this frame inside its turn, so the refusal has to arrive as the response —
   * a `chat.error` alone would leave it waiting for the full timeout.
   */
  const refuseSpawn = (
    fromHostId: string,
    event: { requestId?: string; sourceChatId: string; hostId: string; folder: string },
    code: 'host_not_registered',
    message: string,
  ): void => {
    refuse(fromHostId, event.sourceChatId, code, message);
    if (event.requestId === undefined) return;
    hostLink.sendTo(fromHostId, BRIDGE_SURFACE_ID, {
      type: 'patch.spawn.response',
      requestId: event.requestId,
      sourceChatId: event.sourceChatId,
      hostId: event.hostId,
      folder: event.folder,
      ok: false,
      error: { code, message },
    });
  };

  const unsubscribe = hostLink.onEvent((event: WireEvent, fromHostId: string | null) => {
    if (event.type === 'patch.spawn') {
      // Its own host: the host already created the chat in-process and this
      // frame is the audit trail. Relaying it back would spawn a second chat.
      if (fromHostId === null || event.hostId === fromHostId) return;
      if (!registry.isRegisteredHost(event.hostId)) {
        logger.warn(
          { from: fromHostId, target: event.hostId },
          'patch.spawn named an unregistered machine',
        );
        refuseSpawn(
          fromHostId,
          event,
          'host_not_registered',
          `patch_spawn: no machine registered with hostId: ${event.hostId}`,
        );
        return;
      }
      if (!hostLink.isOnline(event.hostId)) {
        logger.warn(
          { from: fromHostId, target: event.hostId },
          'patch.spawn named an offline machine',
        );
        refuseSpawn(
          fromHostId,
          event,
          'host_not_registered',
          `patch_spawn: machine ${event.hostId} is offline`,
        );
        return;
      }
      logger.info(
        { from: fromHostId, target: event.hostId, folder: event.folder },
        'relaying patch.spawn to another machine',
      );
      if (event.requestId !== undefined) {
        // Remember who asked, so the target's answer can be routed home.
        const requestId = event.requestId;
        const timer = setTimeout(() => spawnRoutes.delete(requestId), RELAY_ROUTE_TTL_MS);
        timer.unref();
        spawnRoutes.set(requestId, { fromHostId, timer });
      }
      hostLink.sendTo(event.hostId, BRIDGE_SURFACE_ID, event);
      return;
    }

    if (event.type === 'patch.spawn.response') {
      // The named machine's own outcome, on its way back to the machine whose
      // agent is still inside the tool call. NO FALLBACK: a response the server
      // cannot route is logged loudly, never dropped in silence — the caller
      // would otherwise sit until its timeout.
      const route = spawnRoutes.get(event.requestId);
      if (!route) {
        logger.warn(
          { requestId: event.requestId, from: fromHostId },
          'patch.spawn.response for a spawn this server did not relay; dropping',
        );
        return;
      }
      clearTimeout(route.timer);
      spawnRoutes.delete(event.requestId);
      logger.info(
        { to: route.fromHostId, target: event.hostId, ok: event.ok },
        'relaying patch.spawn.response back to the calling machine',
      );
      hostLink.sendTo(route.fromHostId, BRIDGE_SURFACE_ID, event);
      return;
    }

    if (event.type === 'patch.list_chats.request') {
      if (fromHostId === null) return;
      const chats = chatRegistry
        .list({
          ...(event.archived === 'only' ? { archivedOnly: true } : {}),
          ...(event.archived === 'include' ? { includeArchived: true } : {}),
        })
        .map((c) => ({
          chatId: c.chatId,
          hostId: c.hostId,
          name: c.name,
          preview: c.preview,
          folder: c.folder,
          status: c.status,
          activity: c.activity,
          pinned: c.pinned,
          pinnedAt: c.pinnedAt,
          lastUpdated: c.lastUpdated,
          statusSummary: c.statusSummary,
        }));
      hostLink.sendTo(fromHostId, BRIDGE_SURFACE_ID, {
        type: 'patch.list_chats.response',
        sourceChatId: event.sourceChatId,
        chatCount: chats.length,
        chats,
      });
      return;
    }

    if (event.type === 'patch.search_chats.request') {
      if (fromHostId === null) return;
      const answer = searchChats({ chatRegistry, chatLogStore }, event.query, event.limit);
      hostLink.sendTo(fromHostId, BRIDGE_SURFACE_ID, {
        type: 'patch.search_chats.response',
        sourceChatId: event.sourceChatId,
        query: event.query,
        ...answer,
      });
      return;
    }

    if (event.type === 'patch.activity.request') {
      if (fromHostId === null) return;
      const caller = fromHostId;
      void activity
        .query({
          since: event.since,
          until: event.until,
          ...(event.messagesCursor !== undefined ? { messagesCursor: event.messagesCursor } : {}),
          ...(event.includeSessions !== undefined
            ? { includeSessions: event.includeSessions }
            : {}),
          ...(event.sessionsCursor !== undefined ? { sessionsCursor: event.sessionsCursor } : {}),
          ...(event.limit !== undefined ? { limit: event.limit } : {}),
        })
        .then((result) => {
          hostLink.sendTo(caller, BRIDGE_SURFACE_ID, {
            type: 'patch.activity.response',
            sourceChatId: event.sourceChatId,
            ...result,
          });
        })
        .catch((err: unknown) => {
          // The caller is blocked on this frame; it times out on its own, but the
          // reason has to be somewhere findable.
          logger.error({ err, from: caller }, 'patch.activity.request could not be answered');
        });
      return;
    }

    if (event.type === 'patch.peek.request' || event.type === 'patch.history.request') {
      // No requestId: a same-host call, already resolved in-process by the
      // calling host — this frame is only its audit record (see file header
      // § 3), and relaying it would perform the read a second time.
      if (fromHostId === null || event.requestId === undefined) return;
      const requestId = event.requestId;
      const responseType =
        event.type === 'patch.peek.request' ? 'patch.peek.response' : 'patch.history.response';
      const resolved = resolveTargetHost(event.targetChatId);
      if (!resolved.ok) {
        logger.warn(
          { from: fromHostId, target: event.targetChatId, code: resolved.code },
          `${event.type} named a chat this server cannot reach`,
        );
        refuse(fromHostId, event.sourceChatId, resolved.code, resolved.message);
        hostLink.sendTo(fromHostId, BRIDGE_SURFACE_ID, {
          type: responseType,
          requestId,
          sourceChatId: event.sourceChatId,
          targetChatId: event.targetChatId,
          ok: false,
          error: { code: resolved.code, message: resolved.message },
        });
        return;
      }
      logger.info(
        { from: fromHostId, target: resolved.hostId, targetChatId: event.targetChatId },
        `relaying ${event.type} to the machine that owns the chat`,
      );
      trackRelay(requestId, fromHostId);
      hostLink.sendTo(resolved.hostId, BRIDGE_SURFACE_ID, event);
      return;
    }

    if (event.type === 'patch.peek.response' || event.type === 'patch.history.response') {
      if (event.requestId === undefined) return;
      const route = takeRelay(event.requestId);
      if (!route) {
        logger.warn(
          { requestId: event.requestId, from: fromHostId },
          `${event.type} for a request this server did not relay; dropping`,
        );
        return;
      }
      hostLink.sendTo(route.fromHostId, BRIDGE_SURFACE_ID, event);
      return;
    }

    if (event.type === 'patch.send_to') {
      // No requestId: a same-host call (or a surface's own direct send),
      // already resolved — see file header § 3. Only a cross-host agent call
      // carries one, and that's the only case this server needs to act on.
      if (fromHostId === null || event.requestId === undefined) return;
      const requestId = event.requestId;
      const resolved = resolveTargetHost(event.targetChatId);
      if (!resolved.ok) {
        logger.warn(
          { from: fromHostId, target: event.targetChatId, code: resolved.code },
          'patch.send_to named a chat this server cannot reach',
        );
        refuse(fromHostId, event.sourceChatId, resolved.code, resolved.message);
        hostLink.sendTo(fromHostId, BRIDGE_SURFACE_ID, {
          type: 'patch.send_to.response',
          requestId,
          sourceChatId: event.sourceChatId,
          targetChatId: event.targetChatId,
          ok: false,
          error: { code: resolved.code, message: resolved.message },
        });
        return;
      }
      logger.info(
        { from: fromHostId, target: resolved.hostId, targetChatId: event.targetChatId },
        'relaying patch.send_to to the machine that owns the chat',
      );
      trackRelay(requestId, fromHostId);
      hostLink.sendTo(resolved.hostId, BRIDGE_SURFACE_ID, event);
      return;
    }

    if (event.type === 'patch.send_to.response') {
      const route = takeRelay(event.requestId);
      if (!route) {
        logger.warn(
          { requestId: event.requestId, from: fromHostId },
          'patch.send_to.response for a request this server did not relay; dropping',
        );
        return;
      }
      hostLink.sendTo(route.fromHostId, BRIDGE_SURFACE_ID, event);
    }
  });

  return () => {
    for (const route of spawnRoutes.values()) clearTimeout(route.timer);
    spawnRoutes.clear();
    for (const route of relayRoutes.values()) clearTimeout(route.timer);
    relayRoutes.clear();
    unsubscribe();
  };
}
