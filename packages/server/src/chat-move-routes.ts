// Moving a chat to another host (spec/04 § Moving a chat to another host).
//
//   POST /api/chats/:id/move   {hostId, folder}
//
// The server is the only party that can reach both hosts, so it drives the
// move as three round trips — `export` on the chat's host, `import` on the
// target with what came back, `retire` on the old host — and then points its
// own chat mirror at the new host, which is what routes every later frame for
// the chat there. The target announces the chat itself (`chat.spawned` +
// `chat.state`), so every surface learns the new host and folder the same way
// it learns about any chat.
//
// NO FALLBACK: a step that fails ends the move there with its own reason. After
// a failed import the old host is told to `release` the chat, so it carries on
// where it was. A retire that fails after a good import still counts the chat
// as moved — the new copy is the live one and the old one takes no turns — but
// the reply says so rather than reading as a clean move.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { ChatMoveBundle, ChatMoveErrorCode, ChatMoveOp, WireEvent } from '@patch/wire';
import type { ChatRegistry } from './chat-registry.js';
import type { ChatLogStore } from './chat-log-store.js';
import type { HostLink } from './host-link.js';
import type { Registry } from './registry.js';
import { checkRegisteredHost, UNKNOWN_HOST_STATUS } from './host-addressing.js';
import { requireAuth } from './folder-routes.js';

export interface ChatMoveRoutesDeps {
  logger: Logger;
  registry: Registry;
  hostLink: HostLink;
  chatRegistry: ChatRegistry;
  /** The server's own copy of every transcript, which a takeover is built from. */
  chatLogStore: ChatLogStore;
  attachmentsDir: string;
  idGenerator: () => string;
  /** Per-step wait. Injectable so a test need not sit through the real one. */
  stepTimeoutMs?: number;
}

/** A bundle can be tens of megabytes each way; still bounded. */
export const CHAT_MOVE_STEP_TIMEOUT_MS = 120_000;

type Response = Extract<WireEvent, { type: 'patch.chat_move.response' }>;

const STATUS_BY_CODE: Record<ChatMoveErrorCode, number> = {
  not_found: 404,
  busy: 409,
  unsupported: 422,
  folder_not_found: 400,
  already_exists: 409,
  too_large: 413,
  internal: 502,
};

const SERVER_SURFACE = '_server';
const BLOB_REF = /"\$blob":"([0-9a-f]{64})"/g;

/**
 * A chat built from the server's copy, for a host that was never asked to
 * export it: its meta, and the blobs the transcript points at. The transcript
 * and canonical transcript. The target installs all of it before announcing
 * the chat, so there is no externally visible half-restored state.
 * Null when the server holds nothing for the chat.
 */
export function buildTakeoverBundle(
  chatId: string,
  chat: ReturnType<ChatRegistry['get']> & object,
  store: ChatLogStore,
  now: number,
  attachmentsDir?: string,
): ChatMoveBundle | null {
  if (!store.has(chatId)) return null;
  const events = store.read(chatId, -1);
  const text = JSON.stringify(events);
  const shas = new Set<string>();
  for (const m of text.matchAll(BLOB_REF)) shas.add(m[1]!);
  const files: ChatMoveBundle['files'] = [];
  const meta = {
    chatId,
    folder: chat.folder,
    name: chat.name,
    preview: chat.preview,
    ...(chat.goal !== null ? { goal: chat.goal } : {}),
    ...(chat.lastGoal !== null ? { lastGoal: chat.lastGoal } : {}),
    ...(chat.reminder !== null ? { reminder: chat.reminder } : {}),
    ...(chat.model !== null ? { model: chat.model } : {}),
    permissionMode: chat.permissionMode,
    ...(chat.context !== null ? { context: chat.context } : {}),
    ...(chat.branches.length > 0 && chat.activeBranchId !== null
      ? {
          branches: chat.branches.map(({ running: _running, ...branch }) => branch),
          activeBranchId: chat.activeBranchId,
        }
      : {}),
    pinned: chat.pinned,
    pinnedAt: chat.pinnedAt,
    disabled: chat.disabled,
    status: chat.status,
    hidden: chat.hidden,
    snoozedUntil: chat.snoozedUntil,
    ...(chat.statusDeclared === true && chat.statusKind !== null && chat.statusSummary !== null
      ? {
          declaredStatus: { kind: chat.statusKind, text: chat.statusSummary, at: chat.lastUpdated },
        }
      : {}),
    nextSeq: 0,
    createdAt: chat.lastUserActivity || chat.lastUpdated || now,
    updatedAt: chat.lastUpdated || now,
    lastUserActivity: chat.lastUserActivity,
  };
  files.push({
    path: 'chat/meta.json',
    data: Buffer.from(JSON.stringify(meta)).toString('base64'),
  });
  if (chat.pendingWake !== null) {
    files.push({
      path: 'chat/wake.json',
      data: Buffer.from(JSON.stringify({ chatId, createdAt: now, ...chat.pendingWake })).toString(
        'base64',
      ),
    });
  }
  for (const sha of shas) {
    const blob = store.readBlob(sha);
    if (!blob) continue;
    files.push({ path: `blob/${sha}`, data: blob.bytes.toString('base64') });
  }
  const attachments: Record<string, unknown> = {};
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const v = value as Record<string, unknown>;
    if (
      typeof v['id'] === 'string' &&
      typeof v['name'] === 'string' &&
      typeof v['mimeType'] === 'string' &&
      (v['kind'] === 'image' || v['kind'] === 'file')
    ) {
      const id = v['id'];
      if (Object.hasOwn(attachments, id)) return;
      const path = attachmentsDir ? join(attachmentsDir, chatId, id) : '';
      if (path && existsSync(path)) {
        const base = v['name'].split(/[/\\]/).pop() ?? v['name'];
        const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || 'file';
        files.push({
          path: `attachment/${id}-${safe}`,
          data: readFileSync(path).toString('base64'),
        });
        attachments[id] = v;
      }
    }
    Object.values(v).forEach(visit);
  };
  events.forEach(visit);
  return { chatId, sourceFolder: chat.folder, files, attachments, events };
}

export function registerChatMoveRoutes(app: FastifyInstance, deps: ChatMoveRoutesDeps): void {
  const timeoutMs = deps.stepTimeoutMs ?? CHAT_MOVE_STEP_TIMEOUT_MS;
  const pending = new Map<
    string,
    { resolve: (ev: Response | 'timeout') => void; timer: NodeJS.Timeout; hostId: string }
  >();
  /** Chats with a move in flight — a second move of the same chat is refused. */
  const moving = new Set<string>();

  // Old copies a takeover left on hosts that were offline, chatId -> the host
  // holding it. Kept on disk so a server restart does not forget them.
  const retiresPath = deps.registry.dataDir
    ? join(deps.registry.dataDir, 'pending-retires.json')
    : null;
  const pendingRetires = new Map<string, string>(loadPendingRetires());
  // Re-derivable bookkeeping: a corrupt file must not stop the server booting.
  // Losing it leaves an old copy on a host, which says so the next time it is used.
  function loadPendingRetires(): [string, string][] {
    if (!retiresPath || !existsSync(retiresPath)) return [];
    try {
      return Object.entries(
        JSON.parse(readFileSync(retiresPath, 'utf8')) as Record<string, string>,
      );
    } catch (err) {
      deps.logger.error(
        { err, path: retiresPath },
        'chat move: pending-retires.json is unreadable; starting with no owed retires',
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
  async function retirePending(hostId: string): Promise<void> {
    for (const [chatId, holder] of [...pendingRetires]) {
      if (holder !== hostId || moving.has(chatId)) continue;
      const res = await step(hostId, SERVER_SURFACE, chatId, 'retire', { force: true });
      // A host that no longer has the chat has nothing to retire.
      if (res !== 'timeout' && (res.ok || res.error?.code === 'not_found')) {
        pendingRetires.delete(chatId);
        savePendingRetires();
        deps.logger.info({ chatId, hostId }, 'chat move: old copy retired after takeover');
      } else {
        deps.logger.error(
          { chatId, hostId, res: res === 'timeout' ? 'timeout' : res.error },
          'chat move: the old host kept its copy after a takeover; will retry when it next connects',
        );
      }
    }
  }
  deps.hostLink.onEvent((event: WireEvent, from) => {
    if (event.type === 'folders.list') {
      // This is the end of the host's startup inventory. Retire stale copies
      // before releasing any interrupted work on that host.
      // The host holds its startup work until this arrives, so it is sent even
      // when retiring failed — that failure is logged and retried next connect.
      void retirePending(event.hostId)
        .catch((err: unknown) =>
          deps.logger.error({ err, hostId: event.hostId }, 'chat move: retiring old copies failed'),
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
    if (event.hostId !== w.hostId || (from !== null && from !== w.hostId)) {
      deps.logger.warn(
        { requestId: event.requestId, asked: w.hostId, answered: event.hostId, from },
        'chat move: response from a host that was not asked; ignoring',
      );
      return;
    }
    pending.delete(event.requestId);
    clearTimeout(w.timer);
    w.resolve(event);
  });

  function step(
    hostId: string,
    surfaceId: string,
    chatId: string,
    op: ChatMoveOp,
    extra: { folder?: string; bundle?: ChatMoveBundle; force?: boolean } = {},
  ): Promise<Response | 'timeout'> {
    const requestId = deps.idGenerator();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve('timeout');
      }, timeoutMs);
      pending.set(requestId, { resolve, timer, hostId });
      deps.hostLink.sendTo(hostId, surfaceId, {
        type: 'patch.chat_move.request',
        requestId,
        hostId,
        chatId,
        op,
        ...extra,
      });
    });
  }

  function hostLabel(hostId: string): string {
    return deps.registry.hostName(hostId) ?? hostId;
  }

  app.post<{
    Params: { id: string };
    Body: { hostId?: unknown; folder?: unknown; fromServerCopy?: unknown };
  }>('/api/chats/:id/move', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const chatId = req.params.id;
    const chat = deps.chatRegistry.get(chatId);
    if (!chat) {
      return reply.code(404).send({ error: 'chat_not_found', message: `no chat ${chatId}` });
    }
    const target = req.body?.hostId;
    const folder = req.body?.folder;
    if (typeof target !== 'string' || target.length === 0) {
      return reply
        .code(400)
        .send({ error: 'hostId_required', message: 'name the host to move it to' });
    }
    if (typeof folder !== 'string' || !folder.startsWith('/')) {
      return reply.code(400).send({
        error: 'folder_required',
        message: 'name the absolute folder it will run in on that host',
      });
    }
    const unknownHost = checkRegisteredHost(deps.registry, target);
    if (unknownHost) return reply.code(UNKNOWN_HOST_STATUS).send(unknownHost);
    const source = chat.hostId;
    if (source === target) {
      return reply
        .code(400)
        .send({ error: 'same_host', message: `this chat is already on ${hostLabel(target)}` });
    }
    // Only the target must be online: a chat whose host is off is built from
    // the server's own copy instead of exported (spec/04 § Moving a chat to
    // another host).
    // The user can also choose it with the old host up: it works for a chat
    // an ordinary move refuses (mid-turn, a timer armed, a Codex session).
    const takeover = req.body?.fromServerCopy === true || !deps.hostLink.isOnline(source);
    for (const host of takeover && !deps.hostLink.isOnline(source) ? [target] : [source, target]) {
      if (!deps.hostLink.isOnline(host)) {
        return reply.code(503).send({
          error: 'host_offline',
          message: `${hostLabel(host)} is offline`,
          hostId: host,
        });
      }
    }
    if (moving.has(chatId)) {
      return reply.code(409).send({ error: 'busy', message: 'this chat is already being moved' });
    }

    moving.add(chatId);
    const log = deps.logger.child({ chatId, from: source, to: target, folder });
    try {
      const fail = (
        stepName: string,
        host: string,
        res: Response | 'timeout',
      ): { status: number; body: { error: string; message: string } } => {
        if (res === 'timeout') {
          return {
            status: 504,
            body: {
              error: 'daemon_timeout',
              message: `${hostLabel(host)} did not answer the ${stepName} in time`,
            },
          };
        }
        const code = res.error?.code ?? 'internal';
        return {
          status: STATUS_BY_CODE[code],
          body: {
            error: code,
            message: `${hostLabel(host)}: ${res.error?.message ?? `${stepName} failed`}`,
          },
        };
      };

      let bundle: ChatMoveBundle;
      if (takeover) {
        const built = buildTakeoverBundle(
          chatId,
          chat,
          deps.chatLogStore,
          Date.now(),
          deps.attachmentsDir,
        );
        if (!built) {
          return reply.code(409).send({
            error: 'no_server_copy',
            message: `${hostLabel(source)} is offline and the server holds no copy of this chat`,
          });
        }
        bundle = built;
        log.info({ files: bundle.files.length }, 'chat move: built from the server copy');
      } else {
        const exported = await step(source, auth.surfaceId, chatId, 'export');
        if (exported === 'timeout' || !exported.ok || !exported.bundle) {
          // A late export may still have frozen the chat; lifting that is harmless if not.
          if (exported === 'timeout') void step(source, auth.surfaceId, chatId, 'release');
          const f = fail('export', source, exported);
          log.warn({ ...f.body }, 'chat move: export failed');
          return reply.code(f.status).send(f.body);
        }
        bundle = exported.bundle;
        log.info({ files: bundle.files.length }, 'chat move: exported');
      }

      const imported = await step(target, auth.surfaceId, chatId, 'import', {
        folder,
        bundle,
      });
      if (imported === 'timeout' || !imported.ok) {
        // A takeover froze nothing on the old host, so there is nothing to lift.
        const released = takeover
          ? 'timeout'
          : await step(source, auth.surfaceId, chatId, 'release');
        const f = fail('import', target, imported);
        log.warn(
          { ...f.body, released: released !== 'timeout' && released.ok },
          'chat move: import failed; released on the old host',
        );
        return reply.code(f.status).send(f.body);
      }

      // From here the chat IS on the target: route everything for it there.
      deps.chatRegistry.rehome(chatId, target, folder);
      log.info('chat move: imported; rehomed');

      if (takeover) {
        if (!deps.hostLink.isOnline(source)) {
          pendingRetires.set(chatId, source);
          savePendingRetires();
          log.info('chat move: taken over; the old host retires its copy when it reconnects');
          return reply.send({ ok: true, chatId, hostId: target, folder });
        }
      }

      const retired = await step(source, auth.surfaceId, chatId, 'retire', {
        ...(takeover ? { force: true } : {}),
      });
      if (retired === 'timeout' || !retired.ok) {
        const f = fail('retire', source, retired);
        log.error({ ...f.body }, 'chat move: arrived, but the old copy was not retired');
        return reply.code(502).send({
          error: 'retire_failed',
          message: `Moved to ${hostLabel(target)}, but ${hostLabel(source)} kept its copy: ${f.body.message}`,
          chatId,
          hostId: target,
          folder,
        });
      }
      log.info('chat move: done');
      return reply.send({ ok: true, chatId, hostId: target, folder });
    } finally {
      moving.delete(chatId);
    }
  });
}
