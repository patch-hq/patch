// Link preview REST route.
//
// GET /api/link-preview?url=<url> — server-side fetches a link that appears in
// a chat message and extracts its <title>/OpenGraph description/image, so the
// web surface can render a small inline preview. Fetched server-side (not by
// the browser) because the target's CORS policy would otherwise block it, and
// because it keeps every previewed site seeing the server's IP rather than
// the caller's on every preview open.
//
// NO FALLBACK: an invalid/unfetchable URL is a 4xx/502 the client surfaces,
// never a silently empty preview.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { verifySurfaceCredential } from '@patch/auth';
import type { Registry } from './registry.js';

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
  try {
    const claims = await verifySurfaceCredential(jwt, { userPublicKey: account.userPublicKey });
    if (registry.isRevoked(claims.surface_id)) throw generic();
  } catch {
    throw generic();
  }
}

export interface LinkPreviewRoutesDeps {
  logger: Logger;
  registry: Registry;
}

const FETCH_TIMEOUT_MS = 5_000;

/** The maximum redirect chain we will walk, each hop re-checked. */
const MAX_REDIRECTS = 5;

/** A redirect the preview refuses to follow; `status` is what the route answers. */
class RedirectRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Blocks the obvious SSRF targets (loopback/private/link-local) reachable from
// the server's own network. Not exhaustive DNS-rebinding protection — this is
// a single-user personal app previewing links the account owner pasted, not a
// public-facing service.
function isBlockedHost(hostname: string): boolean {
  // URL.hostname keeps the brackets on an IPv6 literal: "[::1]".
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.includes(':')) return isBlockedIpv6(h);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  return isBlockedIpv4(Number(m[1]), Number(m[2]));
}

function isBlockedIpv4(a: number, b: number): boolean {
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * The IPv6 equivalents of the same set. `addr` is the bracket-stripped,
 * lower-cased literal as `URL.hostname` normalised it.
 *
 * The ranges are tested on the NUMERIC value of the leading 16-bit group, not
 * on a text prefix: `fd00::1` is unique-local but `fd::1` is 0x00fd and is not,
 * and a prefix match cannot tell those apart — it would block a public address.
 */
function isBlockedIpv6(addr: string): boolean {
  if (addr === '::1' || addr === '::') return true;
  // IPv4-mapped (::ffff:a.b.c.d). Node compresses it to ::ffff:<hex>:<hex>,
  // where the first group is octets a.b — which is all these ranges need.
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(addr);
  if (mapped) {
    const hi = parseInt(mapped[1] as string, 16);
    return isBlockedIpv4(hi >> 8, hi & 0xff);
  }
  // Dotted IPv4-mapped form, if a runtime ever hands it back unnormalised.
  const dotted = /^::ffff:(\d{1,3})\.(\d{1,3})\./.exec(addr);
  if (dotted) return isBlockedIpv4(Number(dotted[1]), Number(dotted[2]));
  const first = addr.split(':')[0];
  if (first === undefined || first === '' || !/^[0-9a-f]{1,4}$/.test(first)) return false;
  const n = parseInt(first, 16);
  // Unique-local fc00::/7 and link-local fe80::/10 — the v6 analogues of
  // 10.0.0.0/8 and 169.254.0.0/16.
  return (n & 0xfe00) === 0xfc00 || (n & 0xffc0) === 0xfe80;
}

// Matches the full <meta ...> tag first so `content` and `property`/`name`
// can appear in either order, then pulls `content` out of just that tag.
function extractMetaContent(
  html: string,
  attr: 'property' | 'name',
  value: string,
): string | undefined {
  const tagRe = new RegExp(`<meta[^>]*\\b${attr}=["']${value}["'][^>]*>`, 'i');
  const tag = tagRe.exec(html)?.[0];
  if (!tag) return undefined;
  const content = /content=(["'])(.*?)\1/is.exec(tag)?.[2];
  return content?.trim() || undefined;
}

function decodeEntities(s: string): string {
  // One pass, so "&amp;lt;" decodes to the text "&lt;" and not on to "<".
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
  };
  return s.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => entities[e]!);
}

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  /** The start of the page's own readable text, so the card shows the page and not just its metadata. */
  excerpt?: string;
}

const EXCERPT_CHARS = 600;

/** Readable body text with scripts, styles and page chrome (nav/header/footer/aside) removed. */
function extractExcerpt(html: string): string | undefined {
  const body = /<body[^>]*>([\s\S]*)/i.exec(html)?.[1] ?? html;
  const text = decodeEntities(
    body
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(
        /<(script|style|noscript|template|svg|nav|header|footer|aside|form)\b[\s\S]*?<\/\1\s*>/gi,
        ' ',
      )
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS).trimEnd()}…` : text;
}

function parsePreview(html: string, baseUrl: string): Omit<LinkPreview, 'url'> {
  const title =
    extractMetaContent(html, 'property', 'og:title') ??
    /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  const description =
    extractMetaContent(html, 'property', 'og:description') ??
    extractMetaContent(html, 'name', 'description');
  const rawImage = extractMetaContent(html, 'property', 'og:image');
  let image: string | undefined;
  if (rawImage) {
    try {
      image = new URL(rawImage, baseUrl).toString();
    } catch {
      image = undefined;
    }
  }
  const excerpt = extractExcerpt(html);
  return {
    ...(title ? { title: decodeEntities(title) } : {}),
    ...(description ? { description: decodeEntities(description) } : {}),
    ...(image ? { image } : {}),
    ...(excerpt ? { excerpt } : {}),
  };
}

const IMAGE_FETCH_TIMEOUT_MS = 5_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * fetch() with redirects walked BY HAND, so every hop goes through the same
 * host check. With `redirect: 'follow'` the check only ever saw the URL the
 * caller named, and a public page that 302s to 127.0.0.1 or the cloud metadata
 * address was fetched anyway — which is the whole of what the check stops.
 */
async function fetchChecked(
  start: URL,
  init: { signal: AbortSignal; headers: Record<string, string> },
  logger: Logger,
): Promise<Response> {
  let target = start;
  for (let hop = 0; ; hop++) {
    const res = await fetch(target.toString(), { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status > 399) return res;
    const location = res.headers.get('location');
    if (location === null) return res;
    if (hop >= MAX_REDIRECTS) {
      throw new RedirectRefused(502, 'fetch_failed', `more than ${MAX_REDIRECTS} redirects`);
    }
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      throw new RedirectRefused(502, 'fetch_failed', 'upstream sent an unreadable Location');
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new RedirectRefused(400, 'invalid_url', 'only http/https URLs are supported');
    }
    if (isBlockedHost(next.hostname)) {
      logger.warn(
        { from: target.toString(), to: next.toString() },
        'link-preview: refused a redirect into a blocked host',
      );
      throw new RedirectRefused(400, 'blocked_host', 'this host cannot be previewed');
    }
    target = next;
  }
}

export function registerLinkPreviewRoutes(app: FastifyInstance, deps: LinkPreviewRoutesDeps): void {
  function validateUrl(
    raw: string,
  ): { ok: true; target: URL } | { ok: false; status: number; error: string; message: string } {
    if (!raw) {
      return { ok: false, status: 400, error: 'invalid_url', message: 'url is required' };
    }
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      return { ok: false, status: 400, error: 'invalid_url', message: 'url is not a valid URL' };
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return {
        ok: false,
        status: 400,
        error: 'invalid_url',
        message: 'only http/https URLs are supported',
      };
    }
    if (isBlockedHost(target.hostname)) {
      return {
        ok: false,
        status: 400,
        error: 'blocked_host',
        message: 'this host cannot be previewed',
      };
    }
    return { ok: true, target };
  }

  app.get<{ Querystring: { url?: string } }>('/api/link-preview', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const validated = validateUrl((req.query?.url ?? '').toString().trim());
    if (!validated.ok) {
      return reply
        .code(validated.status)
        .send({ error: validated.error, message: validated.message });
    }
    const { target } = validated;
    // The timer stays armed through the body read: headers arriving promptly
    // says nothing about whether the body ever finishes.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      let res: Response;
      let html: string;
      try {
        res = await fetchChecked(
          target,
          {
            signal: controller.signal,
            headers: { accept: 'text/html', 'user-agent': 'Patch-LinkPreview/1.0' },
          },
          deps.logger,
        );
        if (!res.ok) {
          return reply.code(502).send({ error: 'fetch_failed', message: `upstream ${res.status}` });
        }
        const contentType = res.headers.get('content-type') ?? '';
        if (!contentType.includes('text/html')) {
          return reply
            .code(415)
            .send({ error: 'unsupported_content_type', message: contentType || 'unknown' });
        }
        html = await res.text();
      } catch (e) {
        if (e instanceof RedirectRefused) {
          return reply.code(e.status).send({ error: e.code, message: e.message });
        }
        deps.logger.warn(
          { url: target.toString(), err: (e as Error).message },
          'link-preview fetch failed',
        );
        return reply.code(502).send({ error: 'fetch_failed', message: (e as Error).message });
      }
      const preview = parsePreview(html, target.toString());
      return reply.code(200).send({ url: target.toString(), ...preview } satisfies LinkPreview);
    } finally {
      clearTimeout(timeout);
    }
  });

  // GET /api/link-preview/image?url=<absolute image url> — proxies the OG
  // image a preview points at, same-origin. A plain `<img src>` can't attach
  // this app's bearer auth, but more importantly the CSP that locks
  // `img-src` down to `'self'`/`data:`/`blob:` (packages/server/src/app.ts)
  // would block the browser loading an arbitrary third-party image URL
  // directly regardless of auth — every preview image rendered as broken.
  // Routing it through here keeps the previewed site seeing the server's IP
  // rather than the caller's, same rationale as the HTML fetch above, and the
  // web client turns the bytes into an object URL (same pattern as the file
  // browser's binary preview in chat-routes.ts).
  app.get<{ Querystring: { url?: string } }>('/api/link-preview/image', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const validated = validateUrl((req.query?.url ?? '').toString().trim());
    if (!validated.ok) {
      return reply
        .code(validated.status)
        .send({ error: validated.error, message: validated.message });
    }
    const { target } = validated;
    // Armed through the body read too, like the HTML fetch above.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    const tooLarge = () =>
      reply.code(413).send({ error: 'image_too_large', message: 'image exceeds size limit' });
    try {
      let res: Response;
      let contentType: string;
      const chunks: Uint8Array[] = [];
      try {
        res = await fetchChecked(
          target,
          {
            signal: controller.signal,
            headers: { accept: 'image/*', 'user-agent': 'Patch-LinkPreview/1.0' },
          },
          deps.logger,
        );
        if (!res.ok) {
          return reply.code(502).send({ error: 'fetch_failed', message: `upstream ${res.status}` });
        }
        contentType = res.headers.get('content-type') ?? '';
        if (!contentType.startsWith('image/')) {
          return reply
            .code(415)
            .send({ error: 'unsupported_content_type', message: contentType || 'unknown' });
        }
        const contentLength = Number(res.headers.get('content-length') ?? '0');
        if (contentLength > MAX_IMAGE_BYTES) return tooLarge();
        // The cap is enforced while reading, since content-length may be absent or wrong.
        let total = 0;
        if (res.body) {
          for await (const chunk of res.body) {
            total += chunk.byteLength;
            if (total > MAX_IMAGE_BYTES) {
              controller.abort();
              return tooLarge();
            }
            chunks.push(chunk);
          }
        }
      } catch (e) {
        if (e instanceof RedirectRefused) {
          return reply.code(e.status).send({ error: e.code, message: e.message });
        }
        deps.logger.warn(
          { url: target.toString(), err: (e as Error).message },
          'link-preview image fetch failed',
        );
        return reply.code(502).send({ error: 'fetch_failed', message: (e as Error).message });
      }
      return reply
        .code(200)
        .header('content-type', contentType)
        .header('cache-control', 'private, max-age=3600')
        .send(Buffer.concat(chunks));
    } finally {
      clearTimeout(timeout);
    }
  });
}
