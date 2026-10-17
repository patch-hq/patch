// Artifact publish + serve tests (spec/14 § Artifacts, spec/01 § Endpoints).
//
// Exercises the real round-trip: the (mock) host sends a
// `patch.artifact.publish_request` over the host link → the server stores the
// page and replies `patch.artifact.publish_response` with the URL → a plain
// unauthenticated GET on that URL returns the HTML with the sandbox CSP that
// keeps agent-authored script out of the SPA's origin. Plus the real-WS check
// that the page body never reaches a surface: only the slim `chat.artifact`
// does.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

const PAGE = '<!doctype html><html><body><h1>hello artifact</h1></body></html>';

/** The served page minus the injected localStorage shim. */
const unshimmed = (html: string): string =>
  html.replace(/<script>\(function\(\)\{[\s\S]*?\}\)\(\);<\/script>/, '');

function publishRequest(
  over: Partial<Extract<WireEvent, { type: 'patch.artifact.publish_request' }>> = {},
): Extract<WireEvent, { type: 'patch.artifact.publish_request' }> {
  return {
    type: 'patch.artifact.publish_request',
    requestId: 'r1',
    chatId: 'c1',
    artifactId: 'a1',
    title: 'Hello',
    path: 'out/report.html',
    html: PAGE,
    ...over,
  };
}

/** Emit a publish_request as the host and wait for the server's response. */
async function publish(
  link: InProcessHostLink,
  event: Extract<WireEvent, { type: 'patch.artifact.publish_request' }>,
): Promise<Extract<WireEvent, { type: 'patch.artifact.publish_response' }>> {
  link.emit(event);
  for (let i = 0; i < 200; i++) {
    const hit = link.sent.find(
      (s) =>
        s.event.type === 'patch.artifact.publish_response' && s.event.requestId === event.requestId,
    );
    if (hit) return hit.event as Extract<WireEvent, { type: 'patch.artifact.publish_response' }>;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no patch.artifact.publish_response');
}

async function bearerFor(user: ReturnType<typeof generateUserKeypair>): Promise<string> {
  return mintSurfaceCredential({
    userPrivateKey: user.privateKey,
    surfaceId: 'srf-test',
    surfaceKind: 'web',
    label: 'test',
  });
}

describe('artifacts', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-artifact-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeApp() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(7));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const hostLink = new InProcessHostLink();
    const built = await buildAll({ logger: false, registry, hostLink });
    hostLink.emit({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '/tmp/chat' });
    return { built, hostLink, registry, user };
  }

  it('stores a published page and serves it back with the sandbox CSP', async () => {
    const { built, hostLink } = await makeApp();
    try {
      const res = await publish(hostLink, publishRequest());
      expect(res.ok).toBe(true);
      expect(res.url).toMatch(/^\/api\/chats\/c1\/artifact\/a1\?sig=[0-9a-f]{64}$/);

      const get = await built.app.inject({ method: 'GET', url: res.url! });
      expect(get.statusCode).toBe(200);
      expect(get.headers['content-type']).toContain('text/html');
      expect(get.headers['content-security-policy']).toBe(
        'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
      );
      expect(unshimmed(get.body)).toBe(PAGE);
    } finally {
      await built.app.close();
    }
  });

  it('republishing the same artifactId replaces the page at the same URL', async () => {
    const { built, hostLink } = await makeApp();
    try {
      const first = await publish(hostLink, publishRequest());
      const second = await publish(
        hostLink,
        publishRequest({ requestId: 'r2', title: 'Hello v2', html: '<p>v2</p>' }),
      );
      expect(second.url).toBe(first.url);
      const get = await built.app.inject({ method: 'GET', url: second.url! });
      expect(unshimmed(get.body)).toBe('<p>v2</p>');
    } finally {
      await built.app.close();
    }
  });

  // The actual `view_file`-images-don't-render bug: the host publishes an
  // image `raw` (see control.ts's `/internal/view_file`), and this must reach
  // the browser with a real image content-type + real bytes, because the
  // frontend puts this exact URL straight into an `<img src>` — an HTML
  // document at that URL, whatever it wraps, is a broken image icon.
  it('accepts a multi-MB raw image (a 3.25 MB screenshot) but still refuses an absurd one', async () => {
    const { built, hostLink } = await makeApp();
    try {
      const big = Buffer.alloc(3_254_449, 7);
      const ok = await publish(
        hostLink,
        publishRequest({
          artifactId: 'a1ab02',
          html: undefined,
          raw: { contentType: 'image/png', base64: big.toString('base64') },
        }),
      );
      expect(ok.ok).toBe(true);
      const huge = await publish(
        hostLink,
        publishRequest({
          requestId: 'req-huge',
          artifactId: 'a1ab03',
          html: undefined,
          raw: { contentType: 'image/png', base64: Buffer.alloc(8_000_000, 7).toString('base64') },
        }),
      );
      expect(huge.ok).toBe(false);
      expect(huge.error?.message).toMatch(/too large/);
    } finally {
      await built.app.close();
    }
  });

  it('serves a `raw` publish with its own content-type and exact bytes, no CSP', async () => {
    const { built, hostLink } = await makeApp();
    try {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      const res = await publish(
        hostLink,
        publishRequest({
          artifactId: 'a1ab01',
          html: undefined,
          raw: { contentType: 'image/png', base64: png.toString('base64') },
        }),
      );
      expect(res.ok).toBe(true);
      expect(res.url).toMatch(/^\/api\/chats\/c1\/artifact\/a1ab01\?sig=[0-9a-f]{64}$/);

      const get = await built.app.inject({ method: 'GET', url: res.url! });
      expect(get.statusCode).toBe(200);
      expect(get.headers['content-type']).toBe('image/png');
      expect(get.headers['content-security-policy']).toBeUndefined();
      expect(get.rawPayload.equals(png)).toBe(true);
    } finally {
      await built.app.close();
    }
  });

  // The Todoist-reported worry: an agent shows an image with `view_file`, then
  // cleans up the source file it just rendered (CLAUDE.md's own "clean up your
  // temp files" instruction). By the time this request lands, the host has
  // already read the source into `raw.base64` (control.ts's `/internal/
  // view_file` reads the file BEFORE calling `publishArtifact`) — the server
  // never holds a path back to it, only the bytes — so deleting the source
  // after publish must not touch what gets served.
  it('keeps serving a raw artifact after the source file that produced it is deleted', async () => {
    const { built, hostLink } = await makeApp();
    const sourceDir = mkdtempSync(join(tmpdir(), 'patch-artifact-source-'));
    try {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      const sourcePath = join(sourceDir, 'shot.png');
      writeFileSync(sourcePath, png);

      const res = await publish(
        hostLink,
        publishRequest({
          artifactId: 'dead6eef',
          html: undefined,
          raw: { contentType: 'image/png', base64: png.toString('base64') },
        }),
      );
      expect(res.ok).toBe(true);

      // The agent removes what it just showed.
      rmSync(sourceDir, { recursive: true, force: true });

      const get = await built.app.inject({ method: 'GET', url: res.url! });
      expect(get.statusCode).toBe(200);
      expect(get.headers['content-type']).toBe('image/png');
      expect(get.rawPayload.equals(png)).toBe(true);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a publish_request with zero or both of html/raw', async () => {
    const { built, hostLink, user } = await makeApp();
    try {
      const neither = await publish(
        hostLink,
        publishRequest({ requestId: 'r-neither', html: undefined }),
      );
      expect(neither.ok).toBe(false);
      expect(neither.error?.message).toMatch(/exactly one of html\/raw/);

      const both = await publish(
        hostLink,
        publishRequest({
          requestId: 'r-both',
          raw: { contentType: 'image/png', base64: 'Zm9v' },
        }),
      );
      expect(both.ok).toBe(false);
      expect(both.error?.message).toMatch(/exactly one of html\/raw/);

      const get = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c1/artifact/a1',
        headers: { authorization: `Bearer ${await bearerFor(user)}` },
      });
      expect(get.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  // A `raw` artifact is two files (`.bin` + `.meta.json`), written in
  // sequence, not atomically — a crash or a disk failure between the two can
  // leave the sidecar without its data. Served as 404, not a corrupt image.
  it('404s a raw artifact whose sidecar survived but whose bytes did not', async () => {
    const { built, registry, user } = await makeApp();
    try {
      const dir = join(registry.dataDir, 'artifacts', 'c1');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ab00ff.meta.json'), JSON.stringify({ contentType: 'image/png' }));
      const get = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c1/artifact/ab00ff',
        headers: { authorization: `Bearer ${await bearerFor(user)}` },
      });
      expect(get.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('404s an unknown artifact and rejects a traversal id', async () => {
    const { built, user } = await makeApp();
    try {
      const headers = { authorization: `Bearer ${await bearerFor(user)}` };
      const missing = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c1/artifact/nope',
        headers,
      });
      expect(missing.statusCode).toBe(404);
      const traversal = await built.app.inject({
        method: 'GET',
        url: '/api/chats/c1/artifact/..%2F..%2Fregistry.json',
        headers,
      });
      expect(traversal.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('sends the slim chat.artifact to a watching surface and never the publish_request', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(9));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-art',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const hostLink = new InProcessHostLink();
    const built = await buildAll({ logger: false, registry, hostLink });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = built.app.server.address() as AddressInfo;
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-art',
      surfaceKind: 'web',
      label: 'browser',
    });
    const client = new WireTestClient({ url: `ws://127.0.0.1:${addr.port}/ws`, auth: jwt });
    await client.connect();
    await client.waitFor('host.online');
    try {
      client.send({ type: 'chat.focus_change', chatId: 'c1' });
      await new Promise((r) => setTimeout(r, 50));

      const leaked: WireEvent[] = [];
      client.on('patch.artifact.publish_request', (e) => leaked.push(e));

      hostLink.emit(publishRequest());
      hostLink.emit({
        type: 'chat.artifact',
        chatId: 'c1',
        artifactId: 'a1',
        title: 'Hello',
        url: '/api/chats/c1/artifact/a1',
        path: 'out/report.html',
        updatedAt: 1,
        seq: 3,
      });
      const got = await client.waitFor('chat.artifact');
      expect((got as { url: string }).url).toBe('/api/chats/c1/artifact/a1');
      expect(leaked).toHaveLength(0);
      await client.close();
    } finally {
      await built.app.close();
    }
  });
  describe('access control', () => {
    it('refuses an unsigned, mis-signed or tampered request', async () => {
      const { built, hostLink } = await makeApp();
      try {
        const res = await publish(hostLink, publishRequest());
        const base = '/api/chats/c1/artifact/a1';
        expect((await built.app.inject({ method: 'GET', url: base })).statusCode).toBe(401);
        const bad = `${base}?sig=${'0'.repeat(64)}`;
        expect((await built.app.inject({ method: 'GET', url: bad })).statusCode).toBe(401);
        // A signature for one artifact does not open another.
        const sig = new URL(res.url!, 'http://x').searchParams.get('sig');
        await publish(hostLink, publishRequest({ requestId: 'r9', artifactId: 'b2' }));
        const other = await built.app.inject({
          method: 'GET',
          url: `/api/chats/c1/artifact/b2?sig=${sig}`,
        });
        expect(other.statusCode).toBe(401);
        // A garbage bearer is refused even with a good sig.
        const garbage = await built.app.inject({
          method: 'GET',
          url: res.url!,
          headers: { authorization: 'Bearer nonsense' },
        });
        expect(garbage.statusCode).toBe(401);
      } finally {
        await built.app.close();
      }
    });

    it('answers a signature of multi-byte characters with 401, not a 500', async () => {
      const { built, hostLink } = await makeApp();
      try {
        await publish(hostLink, publishRequest());
        // 64 characters, 128 bytes: the length of a signature only by counting characters.
        const forged = `/api/chats/c1/artifact/a1?sig=${encodeURIComponent('é'.repeat(64))}`;
        expect((await built.app.inject({ method: 'GET', url: forged })).statusCode).toBe(401);
      } finally {
        await built.app.close();
      }
    });

    it('serves a valid bearer without a signature', async () => {
      const { built, hostLink, user } = await makeApp();
      try {
        await publish(hostLink, publishRequest());
        const get = await built.app.inject({
          method: 'GET',
          url: '/api/chats/c1/artifact/a1',
          headers: { authorization: `Bearer ${await bearerFor(user)}` },
        });
        expect(get.statusCode).toBe(200);
        expect(unshimmed(get.body)).toBe(PAGE);
      } finally {
        await built.app.close();
      }
    });

    it('keeps signed links valid across a server restart', async () => {
      const { built, hostLink } = await makeApp();
      const res = await publish(hostLink, publishRequest());
      await built.app.close();
      const registry = Registry.load(dir);
      const again = await buildAll({
        logger: false,
        registry,
        hostLink: new InProcessHostLink(),
      });
      try {
        const get = await again.app.inject({ method: 'GET', url: res.url! });
        expect(get.statusCode).toBe(200);
      } finally {
        await again.app.close();
      }
    });

    it('mints an expiring share link only for an authenticated caller', async () => {
      const { built, hostLink, user } = await makeApp();
      try {
        await publish(hostLink, publishRequest());
        const share = '/api/chats/c1/artifact/a1/share';
        expect((await built.app.inject({ method: 'POST', url: share })).statusCode).toBe(401);
        const headers = { authorization: `Bearer ${await bearerFor(user)}` };
        const minted = await built.app.inject({
          method: 'POST',
          url: share,
          headers,
          payload: { ttlSeconds: 3600 },
        });
        expect(minted.statusCode).toBe(200);
        const { url, expiresAt } = minted.json() as { url: string; expiresAt: number };
        expect(expiresAt).toBeGreaterThan(Date.now());
        const get = await built.app.inject({ method: 'GET', url });
        expect(get.statusCode).toBe(200);
        expect(unshimmed(get.body)).toBe(PAGE);
        // Extending the expiry by hand invalidates the signature.
        const forged = url.replace(/exp=\d+/, `exp=${expiresAt + 1000}`);
        expect((await built.app.inject({ method: 'GET', url: forged })).statusCode).toBe(401);
        const bad = await built.app.inject({
          method: 'POST',
          url: share,
          headers,
          payload: { ttlSeconds: 5 },
        });
        expect(bad.statusCode).toBe(400);
      } finally {
        await built.app.close();
      }
    });

    it('refuses an expired share link', async () => {
      const { built, hostLink, user } = await makeApp();
      try {
        await publish(hostLink, publishRequest());
        const headers = { authorization: `Bearer ${await bearerFor(user)}` };
        const minted = await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/artifact/a1/share',
          headers,
          payload: { ttlSeconds: 60 },
        });
        const { url } = minted.json() as { url: string };
        const realNow = Date.now;
        Date.now = () => realNow() + 61_000;
        try {
          expect((await built.app.inject({ method: 'GET', url })).statusCode).toBe(401);
        } finally {
          Date.now = realNow;
        }
      } finally {
        await built.app.close();
      }
    });

    it('revoking shares kills share links but not the in-app link', async () => {
      const { built, hostLink, user } = await makeApp();
      try {
        const published = await publish(hostLink, publishRequest());
        const headers = { authorization: `Bearer ${await bearerFor(user)}` };
        const share = '/api/chats/c1/artifact/a1/share';
        const { url } = (
          await built.app.inject({ method: 'POST', url: share, headers })
        ).json() as {
          url: string;
        };
        expect((await built.app.inject({ method: 'DELETE', url: share })).statusCode).toBe(401);
        expect((await built.app.inject({ method: 'DELETE', url: share, headers })).statusCode).toBe(
          204,
        );
        expect((await built.app.inject({ method: 'GET', url })).statusCode).toBe(401);
        expect((await built.app.inject({ method: 'GET', url: published.url! })).statusCode).toBe(
          200,
        );
        // A link minted after revocation works again.
        const fresh = (await built.app.inject({ method: 'POST', url: share, headers })).json() as {
          url: string;
        };
        expect((await built.app.inject({ method: 'GET', url: fresh.url })).statusCode).toBe(200);
      } finally {
        await built.app.close();
      }
    });

    it('404s a share request for an artifact that does not exist', async () => {
      const { built, user } = await makeApp();
      try {
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/artifact/dead/share',
          headers: { authorization: `Bearer ${await bearerFor(user)}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await built.app.close();
      }
    });
  });

  describe('per-artifact storage', () => {
    const put = (built: Awaited<ReturnType<typeof makeApp>>['built'], url: string, body: string) =>
      built.app.inject({
        method: 'PUT',
        url,
        headers: { 'content-type': 'text/plain' },
        payload: body,
      });

    it('persists written state, inlines it into the served page, and shims localStorage', async () => {
      const { built, hostLink } = await makeApp();
      try {
        const res = await publish(hostLink, publishRequest());
        const sig = new URL(res.url!, 'http://x').search;
        const store = `/api/chats/c1/artifact/a1/storage${sig}`;
        const w = await put(built, store, JSON.stringify({ tick: '1', '</script>': 'x' }));
        expect(w.statusCode).toBe(204);
        expect(w.headers['access-control-allow-origin']).toBe('*');
        const r = await built.app.inject({ method: 'GET', url: store });
        expect(JSON.parse(r.body)).toEqual({ tick: '1', '</script>': 'x' });
        const page = await built.app.inject({ method: 'GET', url: res.url! });
        expect(page.body).toContain("Object.defineProperty(window,'localStorage'");
        expect(page.body).toContain('"tick":"1"');
        expect(page.body).not.toContain('</script>":');
        expect(page.body).toContain('hello artifact');
      } finally {
        await built.app.close();
      }
    });

    it('refuses unsigned, wrong-artifact, malformed and oversized writes', async () => {
      const { built, hostLink } = await makeApp();
      try {
        const res = await publish(hostLink, publishRequest());
        const sig = new URL(res.url!, 'http://x').search;
        const base = '/api/chats/c1/artifact/a1/storage';
        expect((await put(built, base, '{}')).statusCode).toBe(401);
        expect((await built.app.inject({ method: 'GET', url: base })).statusCode).toBe(401);
        expect((await put(built, `${base}${sig}`, '[1]')).statusCode).toBe(400);
        expect((await put(built, `${base}${sig}`, '{"a":1}')).statusCode).toBe(400);
        expect((await put(built, `${base}${sig}`, 'nope')).statusCode).toBe(400);
        const big = JSON.stringify({ k: 'x'.repeat(600 * 1024) });
        expect((await put(built, `${base}${sig}`, big)).statusCode).toBe(413);
        expect((await put(built, `/api/chats/c1/artifact/ff/storage${sig}`, '{}')).statusCode).toBe(
          404,
        );
      } finally {
        await built.app.close();
      }
    });

    it('lets a real sandboxed page save in localStorage and read it back after reload', async () => {
      const { built, hostLink } = await makeApp();
      try {
        const page =
          '<!doctype html><html><head><title>t</title></head><body><div id="o"></div><script>' +
          "var n=Number(localStorage.getItem('n')||0)+1;localStorage.setItem('n',String(n));" +
          "document.getElementById('o').textContent='n='+n+' len='+localStorage.length;" +
          '</script></body></html>';
        const res = await publish(hostLink, publishRequest({ html: page }));
        await built.app.listen({ port: 0, host: '127.0.0.1' });
        const port = (built.app.server.address() as AddressInfo).port;
        const pw = await import('playwright');
        const browser = await pw.chromium.launch();
        try {
          const pg = await browser.newPage();
          const errors: string[] = [];
          pg.on('pageerror', (e) => errors.push(e.message));
          await pg.goto(`http://127.0.0.1:${port}${res.url}`);
          expect(await pg.textContent('#o')).toBe('n=1 len=1');
          await pg.waitForResponse(
            (r) => r.url().includes('/storage') && r.request().method() === 'PUT',
          );
          await pg.reload();
          expect(await pg.textContent('#o')).toBe('n=2 len=1');
          expect(errors).toEqual([]);
        } finally {
          await browser.close();
        }
      } finally {
        await built.app.close();
      }
    });
  });
});
