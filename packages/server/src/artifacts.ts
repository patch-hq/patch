// Artifacts — the server half of Patch's own Artifact tool (spec/14
// § Artifacts, spec/01 § Endpoints).
//
// Two pieces:
//   1. A host-link bridge for `patch.artifact.publish_request` (mirrors
//      jobs/rpc-bridge.ts): write the page under `<artifactsDir>/<chatId>/`,
//      reply `patch.artifact.publish_response` with the URL it is now served
//      from. The host only stamps the chat card AFTER this reply, so a
//      failure here never produces a URL that 404s.
//   2. `GET /api/chats/:chatId/artifact/:artifactId` — serves the stored page.
//      Not public: it needs a surface bearer, or a signed link (`?sig=`). The
//      page has to load in a webview/iframe/<img> that cannot attach a bearer
//      header, so the URL handed back at publish carries an HMAC signature
//      (server secret, never guessable from the ids). `POST .../share` mints a
//      separate EXPIRING signed link for handing to someone else, and
//      `DELETE .../share` revokes every share link for that artifact. Served with `Content-Security-Policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox` so
//      agent-authored script runs in an OPAQUE origin and can never read the
//      SPA's stored credential or call the API as the user.
//   3. Per-artifact key-value storage. An opaque origin makes `localStorage`
//      throw, so the served page gets a shim (`storageShim`) that replaces
//      `localStorage` with a synchronous in-page map, hydrated from the state
//      the server inlines at serve time and written back through
//      `PUT .../storage` (same `?sig=` the page was opened with).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { PatchArtifactPublishRequestEvent, type WireEvent } from '@patch/wire';
import { verifySurfaceCredential } from '@patch/auth';
import type { HostLink } from './host-link.js';
import type { Registry } from './registry.js';
import { SIGNIN_PAGE_CSP, signInPage, wantsHtml } from './signin-page.js';

const BRIDGE_SURFACE_ID = 'artifact-bridge';
/** Ids are daemon-minted hex digests; charset-validate before touching the fs. */
const ID_RE = /^[0-9a-f]{2,64}$/;
/** Mirrors the host-side ceiling (spec/14 § Artifacts), post-wrapping. */
const MAX_ARTIFACT_BYTES = 3 * 1024 * 1024;
/** Raw bodies (images, PDFs, videos, files) are base64 of up to 50 MB of source
 * (the host's video/file cap), so they get their own ceiling: 50 MB * 4/3, rounded up. */
const MAX_RAW_ARTIFACT_BYTES = 70 * 1024 * 1024;
/** Opaque origin: agent-authored script cannot touch the SPA's origin.
 * Popups are allowed, and escape the sandbox, so a `target=_blank` link opens
 * a working page; the artifact itself stays opaque either way. */
export const ARTIFACT_CSP = 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox';

/** A `raw`-published artifact's sidecar: what content-type to serve `<id>.bin`
 * back with. Its mere presence (checked before `<id>.html`) is what tells the
 * GET route which of the two this id is — see `registerArtifactRoutes` below. */
interface RawArtifactSidecar {
  contentType: string;
  /** Present for a downloadable file: served as an attachment under this name. */
  filename?: string;
}

export interface ArtifactRoutesDeps {
  logger: Logger;
  hostLink: HostLink;
  registry: Registry;
  /** Root artifacts are written under: `<dir>/<chatId>/<artifactId>.html`. */
  artifactsDir: string;
}

const DEFAULT_SHARE_TTL_S = 7 * 24 * 3600;
const MIN_SHARE_TTL_S = 60;
const MAX_SHARE_TTL_S = 30 * 24 * 3600;

/** The signing secret outlives restarts (links in transcripts must keep working)
 * and is created once. A malformed file is a loud failure: regenerating it
 * would silently kill every link already issued. */
export function loadLinkSecret(artifactsDir: string): Buffer {
  mkdirSync(artifactsDir, { recursive: true });
  const file = join(artifactsDir, '.link-secret');
  if (!existsSync(file)) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, randomBytes(32).toString('hex'), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  }
  const secret = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  if (secret.length !== 32) throw new Error(`artifact link secret ${file} is malformed`);
  return secret;
}

/** Ceiling on one artifact's stored key-value state (serialised JSON). */
const MAX_STORAGE_BYTES = 512 * 1024;

/** Replaces `window.localStorage` (which throws in the sandbox's opaque origin)
 * with a synchronous map seeded from `state`, flushed to the server on change.
 * A failed flush is logged loudly and surfaced as a `storage-error` event on
 * `window` — never swallowed. `sessionStorage` is likewise unavailable, so it
 * becomes a plain in-memory map (it does not survive a reload by definition). */
function storageShim(state: Record<string, string>, storageUrl: string): string {
  const json = JSON.stringify(state).replace(/</g, '\\u003c');
  return `<script>(function(){
var data=${json};var url=${JSON.stringify(storageUrl)}+location.search;var timer=null;
function flush(){timer=null;fetch(url,{method:'PUT',headers:{'content-type':'text/plain'},body:JSON.stringify(data),keepalive:true}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status)}).catch(function(e){console.error('artifact storage save failed',e);window.dispatchEvent(new CustomEvent('storage-error',{detail:String(e)}))})}
function make(map,persist){var api={getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(map,k)?map[k]:null},setItem:function(k,v){map[String(k)]=String(v);persist()},removeItem:function(k){delete map[String(k)];persist()},clear:function(){for(var k in map)delete map[k];persist()},key:function(i){var ks=Object.keys(map);return i<ks.length?ks[i]:null}};
return new Proxy(api,{get:function(t,p){if(p==='length')return Object.keys(map).length;if(p in t)return t[p];return api.getItem(p)},set:function(t,p,v){api.setItem(p,v);return true},deleteProperty:function(t,p){api.removeItem(p);return true},has:function(t,p){return p in t||Object.prototype.hasOwnProperty.call(map,p)},ownKeys:function(){return Object.keys(map)},getOwnPropertyDescriptor:function(t,p){return Object.prototype.hasOwnProperty.call(map,p)?{value:map[p],enumerable:true,configurable:true,writable:true}:undefined}})}
var ls=make(data,function(){if(timer===null)timer=setTimeout(flush,100)});
var ss=make({},function(){});
addEventListener('pagehide',function(){if(timer!==null){clearTimeout(timer);flush()}});
Object.defineProperty(window,'localStorage',{value:ls,configurable:true});
Object.defineProperty(window,'sessionStorage',{value:ss,configurable:true});
addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a||e.defaultPrevented)return;var h=a.getAttribute('href');if(!h||h.charAt(0)==='#'||!/^(https?:|mailto:|tel:)/i.test(a.href))return;e.preventDefault();window.open(a.href,'_blank','noopener')});
})();</script>`;
}

function injectShim(html: string, shim: string): string {
  const at =
    /<head[^>]*>/i.exec(html) ?? /<html[^>]*>/i.exec(html) ?? /^\s*<!doctype[^>]*>/i.exec(html);
  if (!at) return shim + html;
  const i = at.index + at[0].length;
  return html.slice(0, i) + shim + html.slice(i);
}

function safeChatId(chatId: string): boolean {
  return chatId.length > 0 && !chatId.includes('/') && !chatId.includes('..');
}

export function registerArtifactRoutes(app: FastifyInstance, deps: ArtifactRoutesDeps): () => void {
  const secret = loadLinkSecret(deps.artifactsDir);
  const sign = (...parts: (string | number)[]): string =>
    createHmac('sha256', secret).update(parts.join('|')).digest('hex');
  const same = (a: string, b: string): boolean => {
    // Lengths in BYTES: `timingSafeEqual` throws on unequal buffers, and 64
    // multi-byte characters are 64 long but not 64 bytes.
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };
  const appSig = (chatId: string, artifactId: string): string => sign('app', chatId, artifactId);
  const epochFile = (chatId: string, artifactId: string): string =>
    join(deps.artifactsDir, chatId, `${artifactId}.share-epoch`);
  const readEpoch = (chatId: string, artifactId: string): number => {
    const f = epochFile(chatId, artifactId);
    return existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0;
  };
  const shareSig = (chatId: string, artifactId: string, exp: number): string =>
    sign('share', chatId, artifactId, exp, readEpoch(chatId, artifactId));
  const artifactUrl = (chatId: string, artifactId: string): string =>
    `/api/chats/${chatId}/artifact/${artifactId}?sig=${appSig(chatId, artifactId)}`;

  async function hasBearer(req: FastifyRequest): Promise<boolean | 'invalid'> {
    const header = req.headers.authorization;
    if (!header) return false;
    const account = deps.registry.getAccount();
    if (!account || !header.startsWith('Bearer ')) return 'invalid';
    try {
      const claims = await verifySurfaceCredential(header.slice('Bearer '.length).trim(), {
        userPublicKey: account.userPublicKey,
      });
      return deps.registry.isRevoked(claims.surface_id) ? 'invalid' : true;
    } catch {
      return 'invalid';
    }
  }

  /** Bearer, app-signed link, or unexpired share link. */
  async function authorised(
    req: FastifyRequest<{ Querystring: { sig?: string; exp?: string } }>,
    chatId: string,
    artifactId: string,
  ): Promise<boolean> {
    const bearer = await hasBearer(req);
    if (bearer === true) return true;
    if (bearer !== false) return false;
    const { sig, exp } = req.query;
    if (typeof sig !== 'string') return false;
    if (exp === undefined) return same(sig, appSig(chatId, artifactId));
    const expMs = Number(exp);
    return (
      Number.isInteger(expMs) &&
      expMs > Date.now() &&
      same(sig, shareSig(chatId, artifactId, expMs))
    );
  }

  const storageFile = (chatId: string, artifactId: string): string =>
    join(deps.artifactsDir, chatId, `${artifactId}.storage.json`);
  /** A malformed store is a loud failure, not an empty page: serving `{}` would
   * let the next write overwrite the user's saved state. */
  const readStorage = (chatId: string, artifactId: string): Record<string, string> => {
    const f = storageFile(chatId, artifactId);
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Record<string, string>) : {};
  };

  const artifactExists = (chatId: string, artifactId: string): boolean =>
    existsSync(join(deps.artifactsDir, chatId, `${artifactId}.html`)) ||
    existsSync(join(deps.artifactsDir, chatId, `${artifactId}.meta.json`));

  const unsub = deps.hostLink.onEvent((event: WireEvent, fromHostId: string | null) => {
    if (event.type !== 'patch.artifact.publish_request') return;
    const parsed = PatchArtifactPublishRequestEvent.safeParse(event);
    // Answer the machine that asked. `send()` would route by the chat's registry
    // entry or the Manager machine — a chat the server has not mapped yet,
    // or one on a non-Manager machine, never got its answer and the host sat out its
    // timeout (`502 view_file_publish_failed: artifact publish timed out`).
    const reply = (out: WireEvent): void => {
      if (fromHostId !== null) deps.hostLink.sendTo(fromHostId, BRIDGE_SURFACE_ID, out);
      else deps.hostLink.send(BRIDGE_SURFACE_ID, out);
    };
    if (!parsed.success) {
      reply({
        type: 'patch.artifact.publish_response',
        requestId: event.requestId,
        ok: false,
        error: { code: 'invalid_data', message: parsed.error.message },
      });
      return;
    }
    const { requestId, chatId, artifactId, html, raw } = parsed.data;
    if (!safeChatId(chatId) || !ID_RE.test(artifactId)) {
      reply({
        type: 'patch.artifact.publish_response',
        requestId,
        ok: false,
        error: { code: 'invalid_data', message: 'invalid chatId or artifactId' },
      });
      return;
    }
    if ((html === undefined) === (raw === undefined)) {
      reply({
        type: 'patch.artifact.publish_response',
        requestId,
        ok: false,
        error: { code: 'invalid_data', message: 'exactly one of html/raw must be set' },
      });
      return;
    }
    const limit = raw !== undefined ? MAX_RAW_ARTIFACT_BYTES : MAX_ARTIFACT_BYTES;
    if (Buffer.byteLength(html ?? raw!.base64, 'utf8') > limit) {
      reply({
        type: 'patch.artifact.publish_response',
        requestId,
        ok: false,
        error: { code: 'invalid_data', message: 'artifact too large' },
      });
      return;
    }
    try {
      const dir = join(deps.artifactsDir, chatId);
      mkdirSync(dir, { recursive: true });
      // Republish overwrites in place — same id, same URL (spec/14).
      if (raw !== undefined) {
        writeFileSync(join(dir, `${artifactId}.bin`), Buffer.from(raw.base64, 'base64'));
        writeFileSync(
          join(dir, `${artifactId}.meta.json`),
          JSON.stringify({
            contentType: raw.contentType,
            ...(raw.filename !== undefined ? { filename: raw.filename } : {}),
          } satisfies RawArtifactSidecar),
          'utf8',
        );
      } else {
        writeFileSync(join(dir, `${artifactId}.html`), html!, 'utf8');
      }
    } catch (err) {
      deps.logger.error(
        { chatId, artifactId, err: (err as Error).message },
        'artifact: store failed',
      );
      reply({
        type: 'patch.artifact.publish_response',
        requestId,
        ok: false,
        error: { code: 'internal', message: (err as Error).message },
      });
      return;
    }
    reply({
      type: 'patch.artifact.publish_response',
      requestId,
      ok: true,
      url: artifactUrl(chatId, artifactId),
    });
  });

  app.post<{
    Params: { chatId: string; artifactId: string };
    Body: { ttlSeconds?: number } | undefined;
  }>('/api/chats/:chatId/artifact/:artifactId/share', async (req, reply) => {
    if ((await hasBearer(req)) !== true) return reply.code(401).send({ error: 'unauthenticated' });
    const { chatId, artifactId } = req.params;
    if (!safeChatId(chatId) || !ID_RE.test(artifactId) || !artifactExists(chatId, artifactId)) {
      return reply.code(404).send({ error: 'artifact not found' });
    }
    const ttl = req.body?.ttlSeconds ?? DEFAULT_SHARE_TTL_S;
    if (!Number.isInteger(ttl) || ttl < MIN_SHARE_TTL_S || ttl > MAX_SHARE_TTL_S) {
      return reply.code(400).send({
        error: `ttlSeconds must be an integer between ${MIN_SHARE_TTL_S} and ${MAX_SHARE_TTL_S}`,
      });
    }
    const exp = Date.now() + ttl * 1000;
    return reply.code(200).send({
      url: `/api/chats/${chatId}/artifact/${artifactId}?exp=${exp}&sig=${shareSig(chatId, artifactId, exp)}`,
      expiresAt: exp,
    });
  });

  app.delete<{ Params: { chatId: string; artifactId: string } }>(
    '/api/chats/:chatId/artifact/:artifactId/share',
    async (req, reply) => {
      if ((await hasBearer(req)) !== true) {
        return reply.code(401).send({ error: 'unauthenticated' });
      }
      const { chatId, artifactId } = req.params;
      if (!safeChatId(chatId) || !ID_RE.test(artifactId) || !artifactExists(chatId, artifactId)) {
        return reply.code(404).send({ error: 'artifact not found' });
      }
      writeFileSync(epochFile(chatId, artifactId), String(readEpoch(chatId, artifactId) + 1));
      return reply.code(204).send();
    },
  );

  app.get<{
    Params: { chatId: string; artifactId: string };
    Querystring: { sig?: string; exp?: string };
  }>('/api/chats/:chatId/artifact/:artifactId', { logLevel: 'warn' }, async (req, reply) => {
    const { chatId, artifactId } = req.params;
    if (!safeChatId(chatId) || !ID_RE.test(artifactId)) {
      return reply.code(404).send({ error: 'artifact not found' });
    }
    if (!(await authorised(req, chatId, artifactId))) {
      if (wantsHtml(req.headers.accept)) {
        return reply
          .code(401)
          .header('content-type', 'text/html; charset=utf-8')
          .header('content-security-policy', SIGNIN_PAGE_CSP)
          .header('cache-control', 'no-store')
          .send(signInPage(`/api/chats/${chatId}/artifact/${artifactId}/share`));
      }
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    const dir = join(deps.artifactsDir, chatId);
    // A `raw` publish (an image `view_file` result) leaves a sidecar next to
    // its `.bin`; its presence, checked first, is what tells apart the two
    // kinds an id can be. No CSP on this path — it's never HTML, so there's
    // no script for the sandbox directive to contain.
    const metaFile = join(dir, `${artifactId}.meta.json`);
    if (existsSync(metaFile)) {
      const binFile = join(dir, `${artifactId}.bin`);
      if (!existsSync(binFile)) {
        return reply.code(404).send({ error: 'artifact not found' });
      }
      const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as RawArtifactSidecar;
      reply
        .code(200)
        .header('content-type', meta.contentType)
        // The type is agent-chosen: sandbox it like a page so a `text/html`
        // raw publish cannot run in the SPA's origin.
        .header('content-security-policy', ARTIFACT_CSP)
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer');
      if (meta.filename !== undefined) {
        // RFC 5987 form carries any unicode/quote safely; the plain `filename`
        // is the ASCII-only fallback older clients read.
        const ascii = meta.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
        reply.header(
          'content-disposition',
          `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
        );
      }
      // Stream from disk: a video can be 50 MB and a <video> issues many Range
      // requests, so never load the whole file on the event loop.
      const size = statSync(binFile).size;
      // A <video> seeks with byte-range requests; without a 206 it can only
      // play from the start.
      if (meta.contentType.startsWith('video/')) {
        reply.header('accept-ranges', 'bytes');
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        if (m) {
          const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
          const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
          if (start > end || start >= size) {
            return reply.code(416).header('content-range', `bytes */${size}`).send();
          }
          return reply
            .code(206)
            .header('content-range', `bytes ${start}-${end}/${size}`)
            .header('content-length', end - start + 1)
            .send(createReadStream(binFile, { start, end }));
        }
      }
      return reply.header('content-length', size).send(createReadStream(binFile));
    }
    const file = join(dir, `${artifactId}.html`);
    if (!existsSync(file)) {
      return reply.code(404).send({ error: 'artifact not found' });
    }
    const shim = storageShim(
      readStorage(chatId, artifactId),
      `/api/chats/${chatId}/artifact/${artifactId}/storage`,
    );
    return (
      reply
        .code(200)
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-security-policy', ARTIFACT_CSP)
        .header('x-content-type-options', 'nosniff')
        // The signature is in the URL; outbound requests must not carry it.
        .header('referrer-policy', 'no-referrer')
        // A republished page keeps its URL, so a reload must never be answered from cache.
        .header('cache-control', 'no-store')
        .send(injectShim(readFileSync(file, 'utf8'), shim))
    );
  });

  // The page runs in an opaque origin, so its fetches are cross-origin: answer
  // the (unauthenticated-by-origin, signed-by-query) calls with open CORS.
  const storageCors = (reply: { header: (k: string, v: string) => unknown }): void => {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-methods', 'GET, PUT, OPTIONS');
    reply.header('access-control-allow-headers', 'content-type');
  };
  const storagePath = '/api/chats/:chatId/artifact/:artifactId/storage';
  type StorageReq = FastifyRequest<{
    Params: { chatId: string; artifactId: string };
    Querystring: { sig?: string; exp?: string };
  }>;
  app.options(storagePath, { logLevel: 'warn' }, async (_req, reply) => {
    storageCors(reply);
    return reply.code(204).send();
  });
  app.get(storagePath, { logLevel: 'warn' }, async (req: StorageReq, reply) => {
    storageCors(reply);
    const { chatId, artifactId } = req.params;
    if (!safeChatId(chatId) || !ID_RE.test(artifactId) || !artifactExists(chatId, artifactId)) {
      return reply.code(404).send({ error: 'artifact not found' });
    }
    if (!(await authorised(req, chatId, artifactId))) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    return reply.code(200).send(readStorage(chatId, artifactId));
  });
  // Body is the whole key-value map as JSON. `text/plain` keeps the page's
  // PUT free of a preflight; Fastify gets it as a string.
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });
  app.put(
    storagePath,
    { logLevel: 'warn', bodyLimit: MAX_STORAGE_BYTES + 1024 },
    async (req: StorageReq, reply) => {
      storageCors(reply);
      const { chatId, artifactId } = req.params;
      if (!safeChatId(chatId) || !ID_RE.test(artifactId) || !artifactExists(chatId, artifactId)) {
        return reply.code(404).send({ error: 'artifact not found' });
      }
      if (!(await authorised(req, chatId, artifactId))) {
        return reply.code(401).send({ error: 'unauthenticated' });
      }
      const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ error: 'body must be a JSON object of strings' });
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed) ||
        !Object.values(parsed).every((v) => typeof v === 'string')
      ) {
        return reply.code(400).send({ error: 'body must be a JSON object of strings' });
      }
      if (Buffer.byteLength(raw, 'utf8') > MAX_STORAGE_BYTES) {
        return reply.code(413).send({ error: 'artifact storage too large' });
      }
      const file = storageFile(chatId, artifactId);
      writeFileSync(`${file}.tmp`, raw, 'utf8');
      renameSync(`${file}.tmp`, file);
      return reply.code(204).send();
    },
  );

  return unsub;
}
