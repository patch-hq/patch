// Finished chats → the Manager: the send-now route (spec/06 § Finished chats).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

describe('manager finished-chats REST routes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-finished-routes-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootstrap() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(21));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-rest',
      surfaceKind: 'terminal',
      label: 'cli',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-rest',
      surfaceKind: 'terminal',
      label: 'cli',
    });
    const hostLink = new InProcessHostLink();
    const built = await buildAll({ logger: false, registry, hostLink });
    return { jwt, built };
  }

  it('POST /api/manager/finished/send-now says why nothing went: finished chats are off by default', async () => {
    const { jwt, built } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/manager/finished/send-now',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        sent: false,
        outcome: 'refused',
        reason: 'finished chats are off',
      });
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/manager/finished reports what is waiting and the last delivery', async () => {
    const { jwt, built } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/manager/finished',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ waiting: 0, sending: 0, lastSent: null });
      const anon = await built.app.inject({ method: 'GET', url: '/api/manager/finished' });
      expect(anon.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects an unauthenticated send-now', async () => {
    const { built } = await bootstrap();
    try {
      const res = await built.app.inject({ method: 'POST', url: '/api/manager/finished/send-now' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });
});
