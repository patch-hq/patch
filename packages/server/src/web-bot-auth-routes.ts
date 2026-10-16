// Public identity of Patch's browsing agent (Web Bot Auth).
//
//   GET /.well-known/http-message-signatures-directory
//       The signed key directory a site fetches to verify the signatures on
//       Patch's requests (draft-meunier-http-message-signatures-directory).
//   GET /agent
//       The human-readable description of the agent, for site owners and for
//       Cloudflare/Akamai's verified-bot review.
//
// Both are unauthenticated by design — a third-party site has to reach them.
// NO FALLBACK: no key configured → 503 naming the missing variable, never an
// empty directory.

import type { FastifyInstance } from 'fastify';
import {
  DIRECTORY_PATH,
  directoryResponse,
  parseWebBotAuthKey,
  signRequestHeaders,
  type WebBotAuthKey,
} from '@patch/wire/web-bot-auth';
import type { HostLink } from './host-link.js';
import type { Registry } from './registry.js';
import { requireAuth } from './folder-routes.js';
import type { SharedSettings } from '@patch/wire';
import { isIP } from 'node:net';

export const AGENT_PAGE_PATH = '/agent';
export const WEB_BOT_AUTH_STATUS_PATH = '/api/web-bot-auth';

function isPublicAuthority(protocol: string, authority: string): boolean {
  if (protocol !== 'https' || authority.length === 0) return false;
  let hostname: string;
  try {
    hostname = new URL(`https://${authority}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    return false;
  }
  if (isIP(hostname) === 4) {
    const [a = 0, b = 0] = hostname.split('.').map(Number);
    return !(
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(hostname) === 6) {
    return (
      hostname !== '::1' &&
      !hostname.startsWith('fc') &&
      !hostname.startsWith('fd') &&
      !hostname.startsWith('fe8') &&
      !hostname.startsWith('fe9') &&
      !hostname.startsWith('fea') &&
      !hostname.startsWith('feb')
    );
  }
  return hostname.includes('.');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function agentPageHtml(
  directoryUrl: string,
  identity: SharedSettings['agentIdentity'],
): string {
  const name = escapeHtml(identity.name);
  const description = escapeHtml(identity.description);
  const contact = escapeHtml(identity.contact);
  const directory = escapeHtml(directoryUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#111}h1{font-size:1.5rem}</style>
</head>
<body>
<h1>${name}</h1>
<p>${description}</p>
<ul>
<li>It is not a crawler and does not index or collect content in bulk.</li>
<li>It obeys robots.txt.</li>
<li>It makes low request rates, in the manner of one person browsing.</li>
<li>Requests are signed with HTTP Message Signatures (Web Bot Auth, RFC 9421), tag <code>web-bot-auth</code>, and carry a <code>Signature-Agent</code> header pointing to <a href="${directory}">${directory}</a>.</li>
</ul>
${contact ? `<p>Operator contact: ${contact}</p>` : ''}
</body>
</html>
`;
}

export function registerWebBotAuthRoutes(
  app: FastifyInstance,
  opts: {
    keyB64: () => string;
    hostLink: HostLink;
    registry: Registry;
    settings: () => SharedSettings;
  },
): void {
  const unsubscribe = opts.hostLink.onEvent((event, fromHostId) => {
    if (event.type !== 'web_bot_auth.sign_request') return;
    const reply = (
      outcome:
        | { ok: true; result: { headers: Record<string, string> } }
        | { ok: false; error: { code: string; message: string } },
    ) =>
      opts.hostLink.sendTo(event.hostId, 'web-bot-auth', {
        type: 'web_bot_auth.sign_response',
        hostId: event.hostId,
        requestId: event.requestId,
        ...outcome,
      });
    if (fromHostId !== event.hostId) {
      reply({
        ok: false,
        error: { code: 'wrong_host', message: 'signing request names a different host' },
      });
      return;
    }
    try {
      const target = new URL(`https://${event.authority}`);
      if (target.host !== event.authority || target.pathname !== '/') {
        throw new Error('authority is not a host and optional port');
      }
      const directory = new URL(event.directoryUrl);
      if (directory.pathname !== DIRECTORY_PATH || directory.search || directory.hash) {
        throw new Error(`directoryUrl must end at ${DIRECTORY_PATH}`);
      }
      const key = parseWebBotAuthKey(opts.keyB64());
      reply({
        ok: true,
        result: {
          headers: signRequestHeaders(target.href, key, directory.href),
        },
      });
    } catch (err) {
      reply({
        ok: false,
        error: { code: 'signing_failed', message: (err as Error).message },
      });
    }
  });
  app.addHook('onClose', async () => unsubscribe());

  app.get(DIRECTORY_PATH, { logLevel: 'warn' }, async (req, reply) => {
    let key: WebBotAuthKey;
    try {
      key = parseWebBotAuthKey(opts.keyB64());
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
    const { headers, body } = directoryResponse(req.headers.host ?? '', key);
    for (const [name, value] of Object.entries(headers)) reply.header(name, value);
    return reply.code(200).send(Buffer.from(body));
  });

  app.get(AGENT_PAGE_PATH, { logLevel: 'warn' }, async (_req, reply) => {
    return reply
      .code(200)
      .header('Content-Type', 'text/html; charset=utf-8')
      .send(
        agentPageHtml(
          `https://${_req.headers.host ?? 'localhost'}${DIRECTORY_PATH}`,
          opts.settings().agentIdentity,
        ),
      );
  });

  app.get(WEB_BOT_AUTH_STATUS_PATH, async (req, reply) => {
    try {
      await requireAuth(req, opts.registry);
    } catch (err) {
      return reply
        .code((err as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (err as Error).message });
    }
    const forwardedHost = String(req.headers['x-forwarded-host'] ?? '')
      .split(',')[0]
      ?.trim();
    const authority = forwardedHost || req.headers.host || '';
    const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      ?.trim();
    const protocol = forwardedProto || (req.protocol === 'https' ? 'https' : 'http');
    const origin = `${protocol}://${authority}`;
    const key = parseWebBotAuthKey(opts.keyB64());
    const ready = isPublicAuthority(protocol, authority);
    return reply.code(200).send({
      ready,
      issue: ready ? null : 'Web Bot Auth requires a publicly accessible HTTPS server',
      origin,
      agentUrl: `${origin}${AGENT_PAGE_PATH}`,
      directoryUrl: `${origin}${DIRECTORY_PATH}`,
      keyId: key.keyId,
    });
  });
}
