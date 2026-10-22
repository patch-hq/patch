// Composer attachment routes (spec/14 § Composer, spec/15 § Composer —
// "Attachments (images + files)").
//
// Four families of endpoint:
//   1. `POST /api/chats/:chatId/attachment` (multipart: a required `file`
//      field and an optional `model` one) — mirrors the voice-note upload
//      route (`voice/note.ts`): verify the surface credential, reject an
//      unknown chat, buffer the file, then:
//        a. store the `file` bytes + a small metadata sidecar to the server's
//           own attachments dir (so the GET below can serve it back for
//           inline rendering), and
//        b. round-trip the bytes to the HOST over the host link
//           (`patch.attachment.store_*`) so Claude — which runs on the
//           host with the chat folder as cwd — has a copy it can read by
//           path.
//      `file` is the user's ORIGINAL and `model` the client's downscaled
//      copy, so the stream renders full size while the agent reads something
//      inside its vision limits (spec/15 § Composer). Only an actual
//      downscale sends `model`. Returns `{ ok: true, ref }`.
//
//      this same
//      route is now called at ATTACH time, not send time: the chat already
//      exists (a composer draft is always for an EXISTING chat), so nothing
//      about the host hand-off changes. What's new is that a successful
//      upload also registers `ref` onto that chat's composer draft
//      (`DraftAttachmentStore.set`), which broadcasts to every
//      surface — that's what puts the same chip on the phone the instant it
//      lands on desktop.
//
//   2. `GET /api/chats/:chatId/attachment/:id` — mirrors the public APK
//      download static-serve (`app.ts` `/api/download/:name`): streams the
//      stored file back with its mime type. Unauthenticated (like the
//      download route) so an `<img src>` in the chat stream can load it
//      without a bearer header the browser can't attach; the ULID `id` is
//      unguessable and the route is path-traversal-safe (id is
//      charset-validated, never a filename).
//
//   3. `DELETE /api/chats/:chatId/attachment/:id` — step 3 of 3. Removes a
//      chip BEFORE it was ever sent: only valid while `id` is still in that
//      chat's composer-draft attachment list (protects a SENT message's
//      attachment from ever being reachable through this route — once an id
//      has been detached from the draft by a send, it belongs to history).
//      Deletes the server-side serving copy and best-effort asks the host
//      to delete its own copy (`patch.attachment.delete_request`) — nothing
//      is orphaned on disk (spec/14 & spec/15 § Composer → Attachments).
//
//   4. `POST /api/chats/:chatId/attachments/detach` — step 3 of 3,
//      bookkeeping only. Called right after a send hands the chat's current
//      draft attachments to a real message: drops them from the DRAFT's
//      bookkeeping WITHOUT touching a single byte (the message now
//      references the exact same ids/files; deleting them here would corrupt
//      the message that was just sent).
//
//   5. `POST /api/new-chat-drafts/:draftId/attachment`,
//      `GET /api/new-chat-drafts/:draftId/attachment/:id`,
//      `DELETE /api/new-chat-drafts/:draftId/attachment/:id`,
//      `POST /api/new-chat-drafts/:draftId/promote` — step 3 of 3, the
//      new-chat-draft side. A new-chat draft has no chatId (and so no host
//      chat session) until it is actually sent, and the host's
//      `storeAttachment` requires one (`AttachmentChatNotFoundError`
//      otherwise) — so an attachment added here is SERVER-ONLY at attach
//      time: bytes land under `newChatDraftAttachmentsDir/<draftId>/<id>`,
//      registered onto `NewChatDraftStore`, no host round-trip yet.
//      `promote` is the one host hand-off, run once — when the draft
//      becomes a real chat on first send — for every attachment the draft
//      still holds: it MOVES the bytes into the ordinary per-chat
//      attachments dir (reusing the same id, so the ref a surface already
//      rendered keeps working once the response swaps its `url`) and does
//      the host store `POST /api/chats/:chatId/attachment` already does.
//      The client never re-uploads a byte for this — "sending uses the
//      already-uploaded files rather than uploading again."
//
// NO FALLBACK: a missing/invalid credential → 401; an unknown chat/draft →
// 404; the host being silent → 504; a host-side write failure → 502. The
// attachment is NEVER silently dropped.

import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { verifySurfaceCredential } from '@patch/auth';
import {
  type AttachmentKind,
  type AttachmentRef,
  type DraftAttachmentRef,
  type WireEvent,
} from '@patch/wire';
import type { Registry } from './registry.js';
import type { ChatRegistry } from './chat-registry.js';
import type { HostLink } from './host-link.js';
import type { DraftAttachmentStore } from './draft-attachments.js';

const STORE_REQUEST_TIMEOUT_MS = 30_000;
/** Reject files larger than this before spending a host round-trip on them. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Server-minted ids are ULIDs — charset-validate before touching the fs (no traversal). */
const ID_RE = /^[0-9A-Za-z]+$/;

async function requireAuth(
  req: FastifyRequest,
  registry: Registry,
): Promise<{ surfaceId: string }> {
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
  return { surfaceId: claims.surface_id };
}

/** `image/*` → inline picture; everything else → file chip (spec § Composer). */
function kindForMime(mime: string): AttachmentKind {
  return mime.toLowerCase().startsWith('image/') ? 'image' : 'file';
}

/** RFC 5987 ext-value: percent-encode everything outside attr-char. */
function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * What the serve-back is willing to echo back as a Content-Type, and therefore
 * what it will render `inline`.
 *
 * The stored `mimeType` is whatever the uploader's multipart part CLAIMED, and
 * the serve-back is unauthenticated and sits on the SPA's own origin — the one
 * holding the surface credential. Reflecting that claim verbatim with `inline`
 * meant a file uploaded as `text/html` was a program running in that origin.
 * `artifacts.ts` next door spells out the same danger and answers it with a
 * sandbox CSP; this route had nothing.
 *
 * So: a short allow-list of types that are DATA in every renderer, echoed as
 * given; anything else is served as `application/octet-stream` with
 * `attachment`, which downloads rather than renders. `nosniff` rides on every
 * response so the browser cannot recover a richer type from the bytes.
 *
 * SVG is the awkward one and gets its own answer. It IS a real image — the
 * transcript renders image attachments with `<img src>`, so downgrading it would
 * just show a broken picture — but it is also a scriptable DOCUMENT when you
 * navigate straight at it, which is exactly what this route's URL is. Script in
 * an SVG never runs inside an `<img>`, so keeping the type costs nothing there,
 * and the sandbox CSP covers the navigation case by putting the document in an
 * opaque origin that cannot read the SPA's credential. A CSP on a subresource
 * response is ignored, so the `<img>` path is untouched.
 */
const INLINE_SAFE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/heic',
  'image/heif',
  'application/pdf',
  'text/plain',
]);

interface ServedType {
  type: string;
  disposition: 'inline' | 'attachment';
  /** Set only where the type is renderable but scriptable on navigation. */
  csp?: string;
}

function servedContentType(mimeType: string): ServedType {
  // Strip any parameters (`text/html; charset=utf-8`) before deciding.
  const base = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  if (base === 'image/svg+xml') return { type: base, disposition: 'inline', csp: 'sandbox' };
  if (INLINE_SAFE_MIME.has(base)) return { type: base, disposition: 'inline' };
  if (base.startsWith('video/') || base.startsWith('audio/')) {
    return { type: base, disposition: 'inline' };
  }
  return { type: 'application/octet-stream', disposition: 'attachment' };
}

interface AttachmentSidecar {
  name: string;
  mimeType: string;
  kind: AttachmentKind;
}

/** Read `<dir>/<id>.json`, or `undefined` if it's missing/corrupt. */
function readSidecar(dir: string, id: string): AttachmentSidecar | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as AttachmentSidecar;
  } catch {
    return undefined;
  }
}

function writeSidecar(dir: string, id: string, sidecar: AttachmentSidecar): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(sidecar), 'utf8');
}

/** Best-effort delete of a stored serving-copy + its sidecar. Never throws —
 *  a missing file is already the desired end state. */
function deleteStoredFile(dir: string, id: string): void {
  for (const name of [id, `${id}.json`]) {
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

/** Stream a stored attachment back, with the hardened content-type handling
 *  (`servedContentType`) shared by the composer-draft and new-chat-draft GETs. */
function sendStored(
  reply: import('fastify').FastifyReply,
  dataPath: string,
  sidecar: AttachmentSidecar,
): import('fastify').FastifyReply {
  const served = servedContentType(sidecar.mimeType);
  return (
    reply
      .code(200)
      .header('content-type', served.type)
      .header('content-length', String(statSync(dataPath).size))
      // Never let the browser recover a richer (scriptable) type from the
      // bytes after we have decided what this is.
      .header('x-content-type-options', 'nosniff')
      .headers(served.csp ? { 'content-security-policy': served.csp } : {})
      // `inline` so images render in-page; anything not on the safe list
      // downloads instead. The filename rides either way.
      // A header value can't carry chars past U+00FF (Node throws), so
      // `filename` gets an ASCII stand-in and `filename*` the real name.
      .header(
        'content-disposition',
        `${served.disposition}; filename="${sidecar.name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; ` +
          `filename*=UTF-8''${encodeRFC5987(sidecar.name)}`,
      )
      .send(createReadStream(dataPath))
  );
}

function multipartError(reply: import('fastify').FastifyReply, message: string): unknown {
  return reply.code(400).send({ error: message });
}

export interface AttachmentRoutesDeps {
  logger: Logger;
  registry: Registry;
  chatRegistry: ChatRegistry;
  hostLink: HostLink;
  idGenerator: () => string;
  /** Root the server writes its serving-copies under: `<dir>/<chatId>/<id>`. */
  attachmentsDir: string;
  /**
   * Root new-chat-draft attachments live under before they are ever
   * promoted to a real chat: `<dir>/<draftId>/<id>` (step 3 of 3).
   */
  newChatDraftAttachmentsDir: string;
  /** Registers an attach/remove onto the chat's composer draft. */
  composerAttachments: DraftAttachmentStore;
  /** Registers an attach/remove onto a not-yet-spawned new-chat draft. */
  newChatAttachments: DraftAttachmentStore;
}

export function registerAttachmentRoutes(app: FastifyInstance, deps: AttachmentRoutesDeps): void {
  // Correlate `patch.attachment.store_response` frames back to the awaiting HTTP
  // call (same pattern as voice-note / secrets / skills RPCs).
  const pendingStore = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.attachment.store_response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.hostLink.onEvent((event: WireEvent) => {
    if (event.type === 'patch.attachment.store_response') {
      const w = pendingStore.get(event.requestId);
      if (!w) return;
      pendingStore.delete(event.requestId);
      clearTimeout(w.timeout);
      w.resolve(event);
      return;
    }
    // `delete_response` is fire-and-forget from the caller's point of view
    // (see `requestHostDelete` below) — nothing to correlate back to, just
    // log a failure so a systematic leak is visible.
    if (event.type === 'patch.attachment.delete_response' && !event.ok) {
      deps.logger.warn(
        { requestId: event.requestId, error: event.error },
        'attachment: host delete failed',
      );
    }
  });

  function awaitHostStore(
    surfaceId: string,
    build: (requestId: string) => WireEvent,
  ): Promise<Extract<WireEvent, { type: 'patch.attachment.store_response' }> | 'timeout'> {
    const requestId = deps.idGenerator();
    return new Promise((resolveP) => {
      const timeout = setTimeout(() => {
        pendingStore.delete(requestId);
        resolveP('timeout');
      }, STORE_REQUEST_TIMEOUT_MS);
      pendingStore.set(requestId, { resolve: resolveP, timeout });
      deps.hostLink.send(surfaceId, build(requestId));
    });
  }

  /**
   * Best-effort: ask the host to delete its copy of an attachment that was
   * stored at attach time but never made it into a sent message (step 3 of
   * 3 — a chip removed before send). Never awaited by a caller — an offline
   * host or a write failure leaves at most one small stray file inside the
   * chat's own `.patch/attachments/` dir, logged via the response handler
   * above, not a reason to fail the surface's (already-completed) remove.
   */
  function requestHostDelete(surfaceId: string, chatId: string, id: string, name: string): void {
    deps.hostLink.send(surfaceId, {
      type: 'patch.attachment.delete_request',
      requestId: randomUUID(),
      chatId,
      id,
      name,
    });
  }

  /** Shared multipart intake for both upload routes below: a required `file`
   *  part and an optional downscaled `model` part (spec/15 § Composer). */
  async function readMultipartFile(
    req: FastifyRequest,
    ctx: { chatId: string } | { draftId: string },
    startedAt: number,
  ): Promise<
    | {
        ok: true;
        bytes: Buffer;
        modelBytes: Buffer | undefined;
        filename: string;
        mimeType: string;
      }
    | { ok: false; status: number; error: string }
  > {
    if (!req.isMultipart()) {
      return { ok: false, status: 400, error: 'expected multipart/form-data' };
    }
    let bytes: Buffer | undefined;
    let modelBytes: Buffer | undefined;
    let filename = 'attachment';
    let mimeType = 'application/octet-stream';
    try {
      const parts = req.parts({ limits: { files: 2 } });
      for await (const part of parts) {
        if (part.type !== 'file') continue;
        if (part.fieldname === 'model') {
          modelBytes = await part.toBuffer();
          continue;
        }
        if (part.fieldname !== 'file') {
          await part.toBuffer(); // drain unexpected files so the stream doesn't stall
          continue;
        }
        bytes = await part.toBuffer();
        if (part.filename && part.filename.length > 0) filename = part.filename;
        if (part.mimetype && part.mimetype.length > 0) mimeType = part.mimetype;
      }
    } catch (err) {
      deps.logger.warn(
        { ctx, err: (err as Error).message, afterMs: Date.now() - startedAt },
        'attachment: multipart parse failed',
      );
      return { ok: false, status: 400, error: `invalid multipart body: ${(err as Error).message}` };
    }
    if (!bytes || bytes.byteLength === 0) {
      return { ok: false, status: 400, error: 'file is required' };
    }
    deps.logger.info(
      {
        ...ctx,
        filename,
        mimeType,
        bytes: bytes.byteLength,
        modelBytes: modelBytes?.byteLength,
        parseMs: Date.now() - startedAt,
      },
      'attachment: body parsed',
    );
    // Unreachable via HTTP: @fastify/multipart's own `fileSize` limit (app.ts,
    // registered at the same 25MB ceiling) always truncates/rejects an
    // oversized part first, landing in the `catch` above with a 400.
    /* v8 ignore next 3 */
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      return { ok: false, status: 413, error: 'attachment too large' };
    }
    return { ok: true, bytes, modelBytes, filename, mimeType };
  }

  // ==== composer drafts (existing chat) ====================================

  // ---- upload (step 3 of 3: called at ATTACH time) ----
  app.post<{ Params: { chatId: string } }>('/api/chats/:chatId/attachment', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }

    const chatId = req.params.chatId;
    if (!chatId || chatId.length === 0) {
      return reply.code(400).send({ error: 'chatId is required' });
    }

    // Stage logs: an upload that hangs leaves its last stage as the trace.
    const startedAt = Date.now();
    deps.logger.info(
      { chatId, contentLength: req.headers['content-length'] },
      'attachment: upload received',
    );
    const intake = await readMultipartFile(req, { chatId }, startedAt);
    if (!intake.ok) return multipartError(reply, intake.error);
    const { bytes, modelBytes, filename, mimeType } = intake;

    // NO SILENT FALLBACK (mirrors /voice/note): an attachment for an unknown
    // chatId must be rejected, not stored-then-orphaned.
    if (!deps.chatRegistry.get(chatId)) {
      return reply.code(404).send({ error: `chat not found: ${chatId}` });
    }

    const id = deps.idGenerator();
    const kind = kindForMime(mimeType);

    // (a) Store the server's serving-copy + a metadata sidecar. The id is the
    // on-disk name (a server-minted ULID) so the original filename never
    // reaches the fs path — no traversal is possible.
    try {
      const dir = join(deps.attachmentsDir, chatId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, id), bytes);
      writeSidecar(dir, id, { name: filename, mimeType, kind });
    } catch (err) {
      deps.logger.error({ chatId, err: (err as Error).message }, 'attachment: server store failed');
      return reply.code(500).send({ error: 'internal' });
    }

    // (b) Hand a copy to the host so Claude can read it by path. NO FALLBACK:
    // a timeout/daemon error fails the whole upload — the ref would be useless
    // to the agent otherwise.
    const dataBase64 = (modelBytes ?? bytes).toString('base64');
    deps.logger.info({ chatId, id }, 'attachment: sent to host');
    const result = await awaitHostStore(auth.surfaceId, (requestId) => ({
      type: 'patch.attachment.store_request',
      requestId,
      chatId,
      id,
      name: filename,
      mimeType,
      kind,
      dataBase64,
    }));

    if (result === 'timeout') {
      deps.logger.warn({ chatId, id }, 'attachment: host store timed out');
      deleteStoredFile(join(deps.attachmentsDir, chatId), id);
      return reply.code(504).send({ error: 'daemon_timeout' });
    }
    if (!result.ok) {
      const code = result.error?.code ?? 'internal';
      const status = code === 'chat_not_found' ? 404 : 502;
      deleteStoredFile(join(deps.attachmentsDir, chatId), id);
      return reply
        .code(status)
        .send({ error: code, message: result.error?.message ?? 'attachment store failed' });
    }

    deps.logger.info(
      { chatId, id, totalMs: Date.now() - startedAt },
      'attachment: upload complete',
    );
    const ref: DraftAttachmentRef = {
      id,
      name: filename,
      mimeType,
      kind,
      url: `/api/chats/${chatId}/attachment/${id}`,
    };
    // Register onto the chat's composer draft — this is what puts the same
    // chip on every other open surface (spec/14 & spec/15 § Composer →
    // Attachments). A draft with no text yet still gets an entry: the store
    // creates one whenever text OR attachments are non-empty.
    deps.composerAttachments.set(chatId, [...deps.composerAttachments.get(chatId), ref]);

    return reply.code(200).send({ ok: true, ref });
  });

  // ---- serve back (inline rendering) ----
  app.get<{ Params: { chatId: string; id: string } }>(
    '/api/chats/:chatId/attachment/:id',
    { logLevel: 'warn' },
    async (req, reply) => {
      const { chatId, id } = req.params;
      if (!ID_RE.test(id) || chatId.includes('/') || chatId.includes('..')) {
        return reply.code(404).send({ error: 'not found' });
      }
      const dir = join(deps.attachmentsDir, chatId);
      const dataPath = join(dir, id);
      const sidecar = readSidecar(dir, id);
      if (!existsSync(dataPath) || !sidecar) {
        return reply.code(404).send({ error: 'attachment not found' });
      }
      return sendStored(reply, dataPath, sidecar);
    },
  );

  // ---- remove (step 3 of 3: a chip pulled before it was ever sent) ----
  app.delete<{ Params: { chatId: string; id: string } }>(
    '/api/chats/:chatId/attachment/:id',
    async (req, reply) => {
      let auth;
      try {
        auth = await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      const { chatId, id } = req.params;
      const held = deps.composerAttachments.get(chatId);
      const ref = held.find((a) => a.id === id);
      // Only ever lets you delete an id still sitting in the DRAFT — an id
      // that has already gone out in a sent message is history, and this
      // route must never be able to reach it (there is no way to construct
      // a request that both names a sent id and finds it in the draft list,
      // since a send detaches every id the draft held at that moment).
      if (!ref) {
        return reply.code(404).send({ error: 'attachment not found in draft' });
      }
      deps.composerAttachments.set(
        chatId,
        held.filter((a) => a.id !== id),
      );
      deleteStoredFile(join(deps.attachmentsDir, chatId), id);
      requestHostDelete(auth.surfaceId, chatId, id, ref.name);
      return reply.code(200).send({ ok: true });
    },
  );

  // ---- detach (step 3 of 3: bookkeeping only, run right after a send) ----
  app.post<{ Params: { chatId: string }; Body?: { ids?: string[] } }>(
    '/api/chats/:chatId/attachments/detach',
    async (req, reply) => {
      try {
        await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      // Bookkeeping-only: the ids just sent now belong to the message, not
      // the draft. NEVER deletes a byte — see the module doc. With `ids`, only
      // those leave the draft, so a file attached after Send was pressed stays;
      // without, the draft is emptied (older clients).
      const ids = req.body?.ids;
      const held = deps.composerAttachments.get(req.params.chatId);
      deps.composerAttachments.set(
        req.params.chatId,
        ids === undefined ? [] : held.filter((a) => !ids.includes(a.id)),
      );
      return reply.code(200).send({ ok: true });
    },
  );

  // ==== new-chat drafts (no chat yet) =======================================

  // ---- upload (server-only — no host round-trip; there is no chat yet) ----
  app.post<{ Params: { draftId: string } }>(
    '/api/new-chat-drafts/:draftId/attachment',
    async (req, reply) => {
      try {
        await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      const draftId = req.params.draftId;
      if (!draftId || draftId.length === 0) {
        return reply.code(400).send({ error: 'draftId is required' });
      }
      const intake = await readMultipartFile(req, { draftId }, Date.now());
      if (!intake.ok) return multipartError(reply, intake.error);
      const { bytes, modelBytes, filename, mimeType } = intake;

      const id = deps.idGenerator();
      const kind = kindForMime(mimeType);
      try {
        const dir = join(deps.newChatDraftAttachmentsDir, draftId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, id), bytes);
        // The downscaled copy (when there is one) rides alongside the
        // original, ready for the ONE host hand-off `promote` does once the
        // draft becomes a real chat — the client never re-uploads it.
        if (modelBytes) writeFileSync(join(dir, `${id}.model`), modelBytes);
        writeSidecar(dir, id, { name: filename, mimeType, kind });
      } catch (err) {
        deps.logger.error(
          { draftId, err: (err as Error).message },
          'new-chat-draft attachment: server store failed',
        );
        return reply.code(500).send({ error: 'internal' });
      }

      const ref: DraftAttachmentRef = {
        id,
        name: filename,
        mimeType,
        kind,
        url: `/api/new-chat-drafts/${draftId}/attachment/${id}`,
      };
      deps.newChatAttachments.set(draftId, [...deps.newChatAttachments.get(draftId), ref]);

      return reply.code(200).send({ ok: true, ref });
    },
  );

  // ---- serve back (inline rendering) ----
  app.get<{ Params: { draftId: string; id: string } }>(
    '/api/new-chat-drafts/:draftId/attachment/:id',
    { logLevel: 'warn' },
    async (req, reply) => {
      const { draftId, id } = req.params;
      if (!ID_RE.test(id) || draftId.includes('/') || draftId.includes('..')) {
        return reply.code(404).send({ error: 'not found' });
      }
      const dir = join(deps.newChatDraftAttachmentsDir, draftId);
      const dataPath = join(dir, id);
      const sidecar = readSidecar(dir, id);
      if (!existsSync(dataPath) || !sidecar) {
        return reply.code(404).send({ error: 'attachment not found' });
      }
      return sendStored(reply, dataPath, sidecar);
    },
  );

  // ---- remove ----
  app.delete<{ Params: { draftId: string; id: string } }>(
    '/api/new-chat-drafts/:draftId/attachment/:id',
    async (req, reply) => {
      try {
        await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      const { draftId, id } = req.params;
      const held = deps.newChatAttachments.get(draftId);
      if (!held.some((a) => a.id === id)) {
        return reply.code(404).send({ error: 'attachment not found in draft' });
      }
      deps.newChatAttachments.set(
        draftId,
        held.filter((a) => a.id !== id),
      );
      deleteStoredFile(join(deps.newChatDraftAttachmentsDir, draftId), id);
      try {
        rmSync(join(deps.newChatDraftAttachmentsDir, draftId, `${id}.model`), { force: true });
      } catch {
        // Best-effort cleanup only.
      }
      return reply.code(200).send({ ok: true });
    },
  );

  // ---- promote (step 3 of 3: the one host hand-off, run once on first send) ----
  app.post<{ Params: { draftId: string }; Body: { chatId: string } }>(
    '/api/new-chat-drafts/:draftId/promote',
    async (req, reply) => {
      let auth;
      try {
        auth = await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      const { draftId } = req.params;
      const chatId = req.body?.chatId;
      if (!chatId || chatId.length === 0) {
        return reply.code(400).send({ error: 'chatId is required' });
      }
      if (!deps.chatRegistry.get(chatId)) {
        return reply.code(404).send({ error: `chat not found: ${chatId}` });
      }
      const attachments = deps.newChatAttachments.get(draftId);
      const srcDir = join(deps.newChatDraftAttachmentsDir, draftId);
      const destDir = join(deps.attachmentsDir, chatId);
      const refs: AttachmentRef[] = [];
      for (const a of attachments) {
        const sidecar = readSidecar(srcDir, a.id);
        if (!sidecar || !existsSync(join(srcDir, a.id))) {
          // The draft's bookkeeping named an id whose bytes are gone (should
          // not happen outside a corrupted data dir). Sending without the
          // file would silently drop it, so the promote fails and the chip
          // stays for the user to remove.
          deps.logger.error({ draftId, id: a.id }, 'promote: draft attachment bytes missing');
          return reply.code(500).send({ error: 'attachment_missing', id: a.id });
        }
        let bytes: Buffer;
        let modelBytes: Buffer | undefined;
        try {
          bytes = readFileSync(join(srcDir, a.id));
          modelBytes = existsSync(join(srcDir, `${a.id}.model`))
            ? readFileSync(join(srcDir, `${a.id}.model`))
            : undefined;
          mkdirSync(destDir, { recursive: true });
          renameSync(join(srcDir, a.id), join(destDir, a.id));
          writeSidecar(destDir, a.id, sidecar);
        } catch (err) {
          deps.logger.error(
            { draftId, chatId, id: a.id, err: (err as Error).message },
            'promote: move to chat attachments dir failed',
          );
          return reply.code(500).send({ error: 'internal' });
        }
        const dataBase64 = (modelBytes ?? bytes).toString('base64');
        const result = await awaitHostStore(auth.surfaceId, (requestId) => ({
          type: 'patch.attachment.store_request',
          requestId,
          chatId,
          id: a.id,
          name: sidecar.name,
          mimeType: sidecar.mimeType,
          kind: sidecar.kind,
          dataBase64,
        }));
        if (result === 'timeout') {
          deps.logger.warn({ chatId, id: a.id }, 'promote: host store timed out');
          return reply.code(504).send({ error: 'daemon_timeout' });
        }
        if (!result.ok) {
          const code = result.error?.code ?? 'internal';
          const status = code === 'chat_not_found' ? 404 : 502;
          return reply
            .code(status)
            .send({ error: code, message: result.error?.message ?? 'attachment store failed' });
        }
        refs.push({ id: a.id, name: sidecar.name, mimeType: sidecar.mimeType, kind: sidecar.kind });
      }
      // Bookkeeping only — the bytes were MOVED above (renameSync), not
      // copied, so there is nothing left under the draft's dir to delete.
      deps.newChatAttachments.set(draftId, []);
      try {
        rmSync(srcDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup of the now-empty draft dir only.
      }
      return reply.code(200).send({ ok: true, refs });
    },
  );
}

/**
 * Delete every draft attachment `chatId` still holds, both the server-side
 * serving copy AND (best-effort) the host's copy — used by a genuine
 * discard (chat delete, explicit "discard draft") where, unlike a send,
 * nothing downstream will ever reference these ids again (spec/14 & spec/15
 * § Composer → Attachments, "nothing is orphaned on disk"). Exported for
 * `chat-routes.ts` (chat delete), which knows `chatId` and holds a
 * `surfaceId` to route the host request through; this only needs the store
 * and the directory/link.
 */
export function discardComposerDraftAttachments(
  deps: Pick<AttachmentRoutesDeps, 'composerAttachments' | 'attachmentsDir' | 'hostLink'>,
  chatId: string,
  surfaceId: string,
): void {
  const attachments = deps.composerAttachments.get(chatId);
  if (attachments.length === 0) return;
  const dir = join(deps.attachmentsDir, chatId);
  for (const a of attachments) {
    deleteStoredFile(dir, a.id);
    deps.hostLink.send(surfaceId, {
      type: 'patch.attachment.delete_request',
      requestId: randomUUID(),
      chatId,
      id: a.id,
      name: a.name,
    });
  }
  deps.composerAttachments.set(chatId, []);
}
