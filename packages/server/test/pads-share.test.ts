// Pad sharing (spec/14 § Pads — Sharing): a read-only view of a Pad for people
// without a Patch credential, by unguessable link or fully public.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

const PAGE = `<!doctype html><html><head><title>Home</title></head><body><h1>Credit</h1></body></html>`;
const b64 = (s: string): string => Buffer.from(s).toString('base64');

describe('pad sharing', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-padshare-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function setup() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(7));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const hostLink = new InProcessHostLink();
    const built = await buildAll({ logger: false, registry, hostLink });
    hostLink.emit({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '/tmp/chat' });
    const bearer = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-test',
      surfaceKind: 'web',
      label: 'test',
    });
    const auth = { authorization: `Bearer ${bearer}` };
    hostLink.emit({
      type: 'patch.pad.request',
      requestId: 'r1',
      chatId: 'c1',
      op: 'create',
      name: 'Care screens',
      app: 'Dog Log',
      device: 'phone',
      files: [{ path: 'index.html', base64: b64(PAGE) }],
    } as WireEvent);
    let id = '';
    for (let i = 0; i < 300 && !id; i++) {
      const hit = hostLink.sent.find((s) => s.event.type === 'patch.pad.response');
      if (hit) id = (hit.event as any).result.id;
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(id).not.toBe('');
    const share = (body: Record<string, unknown>) =>
      built.app.inject({ method: 'PATCH', url: `/api/pads/${id}`, headers: auth, payload: body });
    return { built, id, auth, share };
  }

  it('a Pad is private until shared: no share URL, no public route', async () => {
    const { built, id, auth } = await setup();
    try {
      const v = await built.app.inject({ method: 'GET', url: `/api/pads/${id}`, headers: auth });
      expect(v.json().share).toBeNull();
      const r = await built.app.inject({ method: 'GET', url: `/api/shared/${id}/` });
      expect(r.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('sharing needs a credential', async () => {
    const { built, id } = await setup();
    try {
      const r = await built.app.inject({
        method: 'PATCH',
        url: `/api/pads/${id}`,
        payload: { share: 'public' },
      });
      expect(r.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('a link share is served read-only to anyone with the token, and rotating it revokes the old link', async () => {
    const { built, id, share } = await setup();
    try {
      const on = (await share({ share: 'link' })).json();
      expect(on.share.mode).toBe('link');
      const url: string = on.share.url;
      expect(url).toMatch(/^\/api\/shared\/[0-9a-f]{32}\/$/);
      expect(url).not.toContain(id);

      const page = await built.app.inject({ method: 'GET', url });
      expect(page.statusCode).toBe(200);
      expect(page.body).not.toContain('id="frame"'); // not the editor
      const state = await built.app.inject({ method: 'GET', url: `${url}api` });
      expect(state.json()).toMatchObject({ name: 'Care screens', screens: [{ name: 'Home' }] });
      expect(JSON.stringify(state.json())).not.toContain('changes');
      const file = await built.app.inject({ method: 'GET', url: `${url}f/index.html` });
      expect(file.body).toContain('Credit');
      // The design runs in an opaque origin, away from Patch's own.
      expect(file.headers['content-security-policy']).toContain('sandbox');
      // No write path.
      const post = await built.app.inject({ method: 'POST', url: `${url}api/send` });
      expect(post.statusCode).toBeGreaterThanOrEqual(404);
      // Escaping the pad is refused.
      const esc = await built.app.inject({ method: 'GET', url: `${url}f/..%2f..%2fpad.json` });
      expect(esc.statusCode).toBeGreaterThanOrEqual(400);
      // The pad id is not a way in for a link share.
      expect(
        (await built.app.inject({ method: 'GET', url: `/api/shared/${id}/` })).statusCode,
      ).toBe(404);

      const rotated = (await share({ share: 'link', rotate: true })).json();
      expect(rotated.share.url).not.toBe(url);
      expect((await built.app.inject({ method: 'GET', url })).statusCode).toBe(404);
      expect((await built.app.inject({ method: 'GET', url: rotated.share.url })).statusCode).toBe(
        200,
      );
    } finally {
      await built.app.close();
    }
  });

  it('a public share is served by pad id; turning sharing off closes it', async () => {
    const { built, id, share } = await setup();
    try {
      const on = (await share({ share: 'public' })).json();
      expect(on.share).toEqual({ mode: 'public', url: `/api/shared/${id}/` });
      expect((await built.app.inject({ method: 'GET', url: on.share.url })).statusCode).toBe(200);
      const off = (await share({ share: 'private' })).json();
      expect(off.share).toBeNull();
      expect((await built.app.inject({ method: 'GET', url: on.share.url })).statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('refuses an unknown share mode', async () => {
    const { built, share } = await setup();
    try {
      expect((await share({ share: 'everyone' })).statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });
});
