// POST /api/link-summary (spec/14 § Message links — Summarise): fetches the
// page, round-trips one `patch.link_summary.request` to the Manager host with
// the account's prompt, and turns its answer into the HTTP response.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

type Req = Extract<WireEvent, { type: 'patch.link_summary.request' }>;
type Res = Extract<WireEvent, { type: 'patch.link_summary.response' }>;

class FakeHost extends InProcessHostLink {
  readonly asked: Req[] = [];
  online = true;
  constructor(
    private readonly respond: (e: Req) => Omit<Res, 'type' | 'requestId' | 'hostId'> | null,
  ) {
    super();
  }
  override isOnline(): boolean {
    return this.online;
  }
  override sendTo(hostId: string, surfaceId: string, event: WireEvent): void {
    super.sendTo(hostId, surfaceId, event);
    if (event.type !== 'patch.link_summary.request') return;
    this.asked.push(event);
    const r = this.respond(event);
    if (r === null) return;
    this.emit(
      { type: 'patch.link_summary.response', requestId: event.requestId, hostId, ...r },
      hostId,
    );
  }
}

const html = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

describe('POST /api/link-summary', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-link-summary-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(link: InProcessHostLink) {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(41));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-ls', surfaceKind: 'web', label: 'b', issuedAt: 1 });
    registry.setDaemonKey({ hostId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-ls',
      surfaceKind: 'web',
      label: 'b',
    });
    const built = await buildAll({ logger: false, registry, hostLink: link, jobsWatch: false });
    return { app: built.app, auth: { authorization: `Bearer ${jwt}` } };
  }
  const post = (app: Awaited<ReturnType<typeof boot>>['app'], auth: object, url: unknown) =>
    app.inject({ method: 'POST', url: '/api/link-summary', headers: auth, payload: { url } });

  it('sends the page text and the account prompt to the Manager host and returns its summary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        html('<body><nav>menu</nav><script>x=1</script><p>Real   article text.</p></body>'),
      ),
    );
    const link = new FakeHost(() => ({ ok: true, summary: 'It is an article.' }));
    const { app, auth } = await boot(link);
    try {
      const res = await post(app, auth, 'https://example.com/a');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ url: 'https://example.com/a', summary: 'It is an article.' });
      expect(link.asked).toHaveLength(1);
      expect(link.asked[0]).toMatchObject({ hostId: 'd1', text: 'Real article text.' });
      expect(link.asked[0]!.prompt).toContain('Summarise the web page');
    } finally {
      await app.close();
    }
  });

  it('caps the text sent to the model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => html(`<body><p>${'word '.repeat(20_000)}</p></body>`)),
    );
    const link = new FakeHost(() => ({ ok: true, summary: 's' }));
    const { app, auth } = await boot(link);
    try {
      await post(app, auth, 'https://example.com/long');
      expect(link.asked[0]!.text.length).toBe(24_000);
    } finally {
      await app.close();
    }
  });

  it('is 401 without a credential', async () => {
    const { app } = await boot(new FakeHost(() => null));
    try {
      expect((await post(app, {}, 'https://example.com')).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['not a url', 'invalid_url'],
    ['ftp://example.com/x', 'invalid_url'],
    ['http://127.0.0.1/x', 'blocked_host'],
    [undefined, 'invalid_url'],
  ])('refuses %s with %s and asks no host', async (url, code) => {
    const link = new FakeHost(() => ({ ok: true, summary: 's' }));
    const { app, auth } = await boot(link);
    try {
      const res = await post(app, auth, url);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(code);
      expect(link.asked).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('is 503 when the Manager host is offline, before fetching anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const link = new FakeHost(() => null);
    link.online = false;
    const { app, auth } = await boot(link);
    try {
      const res = await post(app, auth, 'https://example.com/a');
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('host_offline');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('is 502 when the page cannot be fetched and 415 for a non-text page', async () => {
    const { app, auth } = await boot(new FakeHost(() => ({ ok: true, summary: 's' })));
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 404 })),
      );
      expect((await post(app, auth, 'https://example.com/a')).statusCode).toBe(502);
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () => new Response('x', { status: 200, headers: { 'content-type': 'image/png' } }),
        ),
      );
      expect((await post(app, auth, 'https://example.com/a')).statusCode).toBe(415);
    } finally {
      await app.close();
    }
  });

  it('is 422 for a page with no readable text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => html('<body><script>x</script></body>')),
    );
    const { app, auth } = await boot(new FakeHost(() => ({ ok: true, summary: 's' })));
    try {
      expect((await post(app, auth, 'https://example.com/a')).statusCode).toBe(422);
    } finally {
      await app.close();
    }
  });

  it("surfaces the host's failure reason as a 502, never an empty summary", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => html('<body>text</body>')),
    );
    const { app, auth } = await boot(new FakeHost(() => ({ ok: false, error: 'overloaded' })));
    try {
      const res = await post(app, auth, 'https://example.com/a');
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'summary_failed', message: 'overloaded' });
    } finally {
      await app.close();
    }
  });

  it('is 504 when the host never answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => html('<body>text</body>')),
    );
    const { app, auth } = await boot(new FakeHost(() => null));
    try {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      let settled = false;
      const pending = post(app, auth, 'https://example.com/a').finally(() => {
        settled = true;
      });
      // The host-wait timer is only armed once the request has done real async work, which
      // can take longer than any fixed number of clock steps on a loaded machine. Keep
      // stepping the fake clock, yielding real time between steps, until the request answers.
      const deadline = Date.now() + 20_000;
      while (!settled && Date.now() < deadline) {
        await vi.advanceTimersByTimeAsync(2_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect((await pending).statusCode).toBe(504);
    } finally {
      vi.useRealTimers();
      await app.close();
    }
    // Real time goes on app boot and 40 clock steps; a loaded CI runner needs more than the 10s default.
  }, 30_000);
});
