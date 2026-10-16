// GET /api/link-preview (spec/14 § Message links) — server-side fetch + parse
// of a linked page's title/description/image for the web surface's inline
// preview icon.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

/** A fetch whose headers arrive at once but whose body never finishes, until the
 * request's signal aborts it — as undici behaves for a stalled upstream. */
function stalledBodyFetch(contentType: string) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('<html><head><title>x'));
        init?.signal?.addEventListener('abort', () => c.error(new Error('aborted')));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': contentType } });
  });
}

describe('GET /api/link-preview', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-link-preview-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  async function boot() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(13));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-lp',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-lp',
      surfaceKind: 'web',
      label: 'browser',
    });
    const built = await buildAll({
      dataDir: dir,
      registry,
      hostLink: new InProcessHostLink(),
      jobsWatch: false,
    });
    return { app: built.app, jwt };
  }

  it('extracts og:title / og:description / og:image from the fetched page', async () => {
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="Example Title">
      <meta property="og:description" content="An example &amp; description">
      <meta property="og:image" content="/thumb.png">
      <title>fallback title</title>
    </head><body></body></html>`;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(html, {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
      ),
    );
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('https://example.com/article'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        url: 'https://example.com/article',
        title: 'Example Title',
        description: 'An example & description',
        image: 'https://example.com/thumb.png',
      });
    } finally {
      await app.close();
    }
  });

  it('keeps an apostrophe inside a double-quoted content attribute', async () => {
    const html = `<html><head><meta property="og:title" content="Tom's Blog"></head></html>`;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    );
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('https://example.com/a'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.json().title).toBe("Tom's Blog");
    } finally {
      await app.close();
    }
  });

  it('decodes an entity once: &amp;lt; reads as the text &lt;', async () => {
    const html = `<html><head><meta property="og:title" content="a &amp;lt; b"></head></html>`;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    );
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('https://example.com/a'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.json().title).toBe('a &lt; b');
    } finally {
      await app.close();
    }
  });

  it('rejects the IPv6 loopback [::1] without fetching it', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('http://[::1]:3000/'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('blocked_host');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('falls back to <title> when there is no og:title', async () => {
    const html = `<!doctype html><html><head><title>Plain Title</title></head><body></body></html>`;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    );
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('https://example.com/'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().title).toBe('Plain Title');
    } finally {
      await app.close();
    }
  });

  it('refuses an unauthenticated caller', async () => {
    const { app } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('https://example.com/'),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects a non-http(s) URL', async () => {
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('file:///etc/passwd'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_url');
    } finally {
      await app.close();
    }
  });

  it('rejects a request naming a private/loopback host, without fetching it', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('http://127.0.0.1:8080/secret'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('blocked_host');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('surfaces an upstream fetch failure as 502, not a silent empty preview', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network unreachable');
      }),
    );
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('https://example.com/'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('fetch_failed');
    } finally {
      await app.close();
    }
  });

  it('gives up on a page whose body stalls, rather than hanging the request', async () => {
    vi.stubGlobal('fetch', stalledBodyFetch('text/html'));
    const { app, jwt } = await boot();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('https://example.com/slow'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const res = await pending;
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('fetch_failed');
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });

  it('rejects a non-html response rather than parsing it as one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"not":"html"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview?url=' + encodeURIComponent('https://example.com/data.json'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(415);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/link-preview/image', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-link-preview-image-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  async function boot() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(13));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-lp-img',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-lp-img',
      surfaceKind: 'web',
      label: 'browser',
    });
    const built = await buildAll({
      dataDir: dir,
      registry,
      hostLink: new InProcessHostLink(),
      jobsWatch: false,
    });
    return { app: built.app, jwt };
  }

  it('proxies the image bytes with the original content-type — no plain <img src> can carry the bearer header, and the CSP blocks a third-party img-src regardless', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }),
      ),
    );
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview/image?url=' + encodeURIComponent('https://example.com/thumb.png'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(Uint8Array.from(res.rawPayload)).toEqual(bytes);
    } finally {
      await app.close();
    }
  });

  it('refuses an unauthenticated caller', async () => {
    const { app } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview/image?url=' + encodeURIComponent('https://example.com/thumb.png'),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects a request naming a private/loopback host, without fetching it', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview/image?url=' + encodeURIComponent('http://127.0.0.1:8080/thumb.png'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('blocked_host');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('gives up on an image whose body stalls, rather than hanging the request', async () => {
    vi.stubGlobal('fetch', stalledBodyFetch('image/png'));
    const { app, jwt } = await boot();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = app.inject({
        method: 'GET',
        url: '/api/link-preview/image?url=' + encodeURIComponent('https://example.com/slow.png'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const res = await pending;
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('fetch_failed');
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });

  it('stops reading an image with no content-length once it passes the size cap', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // 32MB with no content-length: only a cap applied while reading stops early.
        const body = new ReadableStream<Uint8Array>({
          pull(c) {
            if (sent >= 32 * 1024 * 1024) return c.close();
            sent += chunk.byteLength;
            c.enqueue(chunk);
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
      }),
    );
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/link-preview/image?url=' + encodeURIComponent('https://example.com/huge.png'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().error).toBe('image_too_large');
      expect(sent).toBeLessThan(16 * 1024 * 1024);
    } finally {
      await app.close();
    }
  });

  it('rejects a non-image response rather than proxying it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    );
    const { app, jwt } = await boot();
    try {
      const res = await app.inject({
        method: 'GET',
        url:
          '/api/link-preview/image?url=' + encodeURIComponent('https://example.com/not-an-image'),
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(415);
    } finally {
      await app.close();
    }
  });
});
