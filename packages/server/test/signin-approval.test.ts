// Sign-in by approval from another device (spec/10 § Surface linking):
// request → allow on a signed-in surface (reveals a code) → type it → credential.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';
import { SignInRequestStore, SIGNIN_REQUEST_TTL_MS } from '../src/signin-requests.js';

describe('sign-in by approval', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-signin-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(41));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-a', surfaceKind: 'web', label: 'mac', issuedAt: 1 });
    const { app } = await buildAll({
      logger: false,
      registry,
      hostLink: new InProcessHostLink(),
    });
    const bearer = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-a',
      surfaceKind: 'web',
      label: 'mac',
    });
    const auth = { authorization: `Bearer ${bearer}` };
    return { app, registry, auth };
  }

  it('request → approve → redeem mints a working credential', async () => {
    const { app, registry, auth } = await setup();
    try {
      const reqRes = await app.inject({
        method: 'POST',
        url: '/api/auth/signin/request',
        payload: { clientType: 'surface-web', label: 'Chrome on Mac' },
      });
      expect(reqRes.statusCode).toBe(200);
      const { id, secret } = reqRes.json() as { id: string; secret: string };

      const pending = await app.inject({
        method: 'GET',
        url: '/api/auth/signin/pending',
        headers: auth,
      });
      expect((pending.json() as { requests: { id: string; label: string }[] }).requests).toEqual([
        expect.objectContaining({ id, label: 'Chrome on Mac' }),
      ]);

      const state1 = await app.inject({
        method: 'GET',
        url: `/api/auth/signin/${id}/state?secret=${secret}`,
      });
      expect(state1.json()).toEqual({ state: 'pending' });

      const approve = await app.inject({
        method: 'POST',
        url: `/api/auth/signin/${id}/approve`,
        headers: auth,
      });
      expect(approve.statusCode).toBe(200);
      const { code } = approve.json() as { code: string };
      expect(code).toMatch(/^\d{6}$/);

      const state2 = await app.inject({
        method: 'GET',
        url: `/api/auth/signin/${id}/state?secret=${secret}`,
      });
      expect(state2.json()).toEqual({ state: 'approved' });

      const redeem = await app.inject({
        method: 'POST',
        url: `/api/auth/signin/${id}/redeem`,
        payload: { secret, code },
      });
      expect(redeem.statusCode).toBe(200);
      const { credential, surfaceId } = redeem.json() as { credential: string; surfaceId: string };
      expect(registry.getSurface(surfaceId)?.surfaceKind).toBe('web');
      const me = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${credential}` },
      });
      expect(me.statusCode).toBe(200);

      // single use
      const again = await app.inject({
        method: 'POST',
        url: `/api/auth/signin/${id}/redeem`,
        payload: { secret, code },
      });
      expect(again.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('approve / deny / pending need a signed-in surface', async () => {
    const { app } = await setup();
    try {
      const { id } = (
        await app.inject({
          method: 'POST',
          url: '/api/auth/signin/request',
          payload: { clientType: 'surface-web' },
        })
      ).json() as { id: string };
      for (const [method, url] of [
        ['GET', '/api/auth/signin/pending'],
        ['POST', `/api/auth/signin/${id}/approve`],
        ['POST', `/api/auth/signin/${id}/deny`],
      ] as const) {
        const res = await app.inject({ method, url });
        expect(res.statusCode).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it('redeem before approval is refused, and deny is reported to the asker', async () => {
    const { app, auth } = await setup();
    try {
      const { id, secret } = (
        await app.inject({
          method: 'POST',
          url: '/api/auth/signin/request',
          payload: { clientType: 'surface-web' },
        })
      ).json() as { id: string; secret: string };
      const early = await app.inject({
        method: 'POST',
        url: `/api/auth/signin/${id}/redeem`,
        payload: { secret, code: '000000' },
      });
      expect(early.statusCode).toBe(409);
      expect(early.json()).toEqual({ error: 'not_approved' });

      const deny = await app.inject({
        method: 'POST',
        url: `/api/auth/signin/${id}/deny`,
        headers: auth,
      });
      expect(deny.statusCode).toBe(200);
      const state = await app.inject({
        method: 'GET',
        url: `/api/auth/signin/${id}/state?secret=${secret}`,
      });
      expect(state.json()).toEqual({ state: 'denied' });
    } finally {
      await app.close();
    }
  });

  it('a wrong secret learns nothing; wrong codes burn the request after three', async () => {
    const { app, auth } = await setup();
    try {
      const { id, secret } = (
        await app.inject({
          method: 'POST',
          url: '/api/auth/signin/request',
          payload: { clientType: 'surface-web' },
        })
      ).json() as { id: string; secret: string };
      const bad = await app.inject({
        method: 'GET',
        url: `/api/auth/signin/${id}/state?secret=nope`,
      });
      expect(bad.statusCode).toBe(404);

      const { code } = (
        await app.inject({ method: 'POST', url: `/api/auth/signin/${id}/approve`, headers: auth })
      ).json() as { code: string };
      const wrong = code === '111111' ? '222222' : '111111';
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await app.inject({
          method: 'POST',
          url: `/api/auth/signin/${id}/redeem`,
          payload: { secret, code: wrong },
        });
        statuses.push(r.statusCode);
      }
      expect(statuses).toEqual([403, 403, 409]);
      // even the right code is now refused
      const right = await app.inject({
        method: 'POST',
        url: `/api/auth/signin/${id}/redeem`,
        payload: { secret, code },
      });
      expect(right.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});

describe('SignInRequestStore', () => {
  it('expires requests and caps how many wait', () => {
    const store = new SignInRequestStore();
    const r = store.create('x', 1000);
    expect(store.stateFor(r.id, r.secret, 1000 + SIGNIN_REQUEST_TTL_MS)).toBe('expired');
    expect(store.approve(r.id, 1000 + SIGNIN_REQUEST_TTL_MS)).toBeUndefined();
    for (let i = 0; i < 5; i++) store.create('y', 1000 + SIGNIN_REQUEST_TTL_MS + 5000);
    expect(() => store.create('z', 1000 + SIGNIN_REQUEST_TTL_MS + 5000)).toThrow(/too many/);
  });
});
