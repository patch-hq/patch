// MCP Apps REST (SEP-1865): a gate and a relay — see src/mcp-app-routes.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

type Req = Extract<WireEvent, { type: 'patch.mcp_app.request' }>;
type Res = Extract<WireEvent, { type: 'patch.mcp_app.response' }>;

class FakeHost extends InProcessHostLink {
  readonly asked: Req[] = [];
  constructor(private readonly respond: (e: Req) => Omit<Res, 'type' | 'requestId' | 'hostId'>) {
    super();
  }
  override sendTo(hostId: string, surfaceId: string, event: WireEvent): void {
    super.sendTo(hostId, surfaceId, event);
    if (event.type !== 'patch.mcp_app.request') return;
    this.asked.push(event);
    this.emit(
      {
        type: 'patch.mcp_app.response',
        requestId: event.requestId,
        hostId,
        ...this.respond(event),
      },
      hostId,
    );
  }
}

describe('mcp app routes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-mcp-app-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function boot(link: InProcessHostLink) {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(33));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-phone',
      surfaceKind: 'mobile',
      label: 'phone',
      issuedAt: 1,
    });
    registry.setDaemonKey({ hostId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-phone',
      surfaceKind: 'mobile',
      label: 'phone',
    });
    const built = await buildAll({ logger: false, registry, hostLink: link });
    return { built, auth: { authorization: `Bearer ${jwt}` } };
  }

  const body = { chatId: 'c1', op: 'resource', server: 'dash', tool: 'show' };

  it('relays a request to the named host and returns the template', async () => {
    const link = new FakeHost(() => ({ ok: true, hasUi: true, html: '<p>x</p>', uiMeta: {} }));
    const { built, auth } = await boot(link);
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/hosts/d1/mcp-app',
        headers: auth,
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ hasUi: true, html: '<p>x</p>' });
      expect(link.asked[0]).toMatchObject({
        hostId: 'd1',
        chatId: 'c1',
        server: 'dash',
        tool: 'show',
      });
    } finally {
      await built.app.close();
    }
  });

  it('keeps the host refusal status', async () => {
    const link = new FakeHost(() => ({
      ok: false,
      error: { code: 'not_app_visible', message: 'no' },
    }));
    const { built, auth } = await boot(link);
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/hosts/d1/mcp-app',
        headers: auth,
        payload: { ...body, op: 'call' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'not_app_visible' });
    } finally {
      await built.app.close();
    }
  });

  it('refuses an unauthenticated caller, a bad body and an unknown host', async () => {
    const { built, auth } = await boot(new FakeHost(() => ({ ok: true })));
    try {
      const anon = await built.app.inject({
        method: 'POST',
        url: '/api/hosts/d1/mcp-app',
        payload: body,
      });
      expect(anon.statusCode).toBe(401);
      const bad = await built.app.inject({
        method: 'POST',
        url: '/api/hosts/d1/mcp-app',
        headers: auth,
        payload: { chatId: 'c1' },
      });
      expect(bad.statusCode).toBe(400);
      const unknown = await built.app.inject({
        method: 'POST',
        url: '/api/hosts/nope/mcp-app',
        headers: auth,
        payload: body,
      });
      expect(unknown.statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      await built.app.close();
    }
  });
});
