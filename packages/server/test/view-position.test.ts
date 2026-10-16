// View position handover, end to end (spec/05 § Handover): a surface's
// `view_position.set` is stamped with its surface id, persisted, and fanned out;
// a surface connecting later is told where the user was.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateUserKeypair, mintSurfaceCredential, type UserKeypair } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import { buildAll, type BuiltApp } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

interface TestCtx {
  dir: string;
  user: UserKeypair;
  registry: Registry;
  hostLink: InProcessHostLink;
  built: BuiltApp;
  url: string;
  clientFor: (surfaceId: string) => Promise<WireTestClient>;
  restJwt: () => Promise<string>;
}

async function setUp(): Promise<TestCtx> {
  const dir = mkdtempSync(join(tmpdir(), 'patch-view-position-e2e-'));
  const user = generateUserKeypair(() => new Uint8Array(32).fill(31));
  const registry = Registry.load(dir);
  registry.bootstrapAccount({ keypair: user });
  registry.upsertSurface({ surfaceId: 'srf-a', surfaceKind: 'web', label: 'a', issuedAt: 1 });
  registry.upsertSurface({ surfaceId: 'srf-b', surfaceKind: 'web', label: 'b', issuedAt: 1 });
  registry.upsertSurface({ surfaceId: 'srf-c', surfaceKind: 'mobile', label: 'c', issuedAt: 1 });
  registry.upsertSurface({
    surfaceId: 'srf-rest',
    surfaceKind: 'terminal',
    label: 'cli',
    issuedAt: 1,
  });
  registry.setDaemonKey({ hostId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
  const hostLink = new InProcessHostLink();
  const built = await buildAll({ logger: false, registry, hostLink });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address() as AddressInfo;
  const url = `ws://127.0.0.1:${addr.port}/ws`;

  async function clientFor(surfaceId: string): Promise<WireTestClient> {
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId,
      surfaceKind: surfaceId === 'srf-c' ? 'mobile' : 'web',
      label: surfaceId,
    });
    const client = new WireTestClient({ url, auth: jwt });
    const online = client.waitFor('auth.ok');
    await client.connect();
    await online;
    return client;
  }

  async function restJwt(): Promise<string> {
    return mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-rest',
      surfaceKind: 'terminal',
      label: 'cli',
    });
  }

  return { dir, user, registry, hostLink, built, url, clientFor, restJwt };
}

async function cleanUp(ctx: TestCtx): Promise<void> {
  await ctx.built.app.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}

describe('view position handover', () => {
  it('a set from one surface reaches another stamped with the sender', async () => {
    const ctx = await setUp();
    try {
      const a = await ctx.clientFor('srf-a');
      const b = await ctx.clientFor('srf-b');
      try {
        const got = b.waitFor('view_position.updated');
        a.send({ type: 'view_position.set', page: 'chat', id: 'c1', seq: 42 });
        expect(await got).toMatchObject({
          type: 'view_position.updated',
          page: 'chat',
          id: 'c1',
          seq: 42,
          surfaceId: 'srf-a',
        });
      } finally {
        await a.close();
        await b.close();
      }
    } finally {
      await cleanUp(ctx);
    }
  });

  it('a surface connecting later is told the current position right after auth.ok', async () => {
    const ctx = await setUp();
    try {
      const a = await ctx.clientFor('srf-a');
      try {
        a.send({ type: 'view_position.set', page: 'jobs' });
        await a.waitFor('view_position.updated');
        const jwtC = await mintSurfaceCredential({
          userPrivateKey: ctx.user.privateKey,
          surfaceId: 'srf-c',
          surfaceKind: 'mobile',
          label: 'srf-c',
        });
        const c = new WireTestClient({ url: ctx.url, auth: jwtC });
        const got = c.waitFor('view_position.updated');
        await c.connect();
        try {
          expect(await got).toMatchObject({ page: 'jobs', surfaceId: 'srf-a' });
        } finally {
          await c.close();
        }
      } finally {
        await a.close();
      }
    } finally {
      await cleanUp(ctx);
    }
  });

  it('survives a restart of the store and reads a corrupt file as empty', async () => {
    const { ViewPositionStore } = await import('../src/view-position.js');
    const { writeFileSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'patch-view-position-'));
    try {
      new ViewPositionStore({ dataDir: dir }).set('srf-a', { page: 'chat', id: 'c1', seq: 7 });
      expect(new ViewPositionStore({ dataDir: dir }).get()).toMatchObject({
        page: 'chat',
        id: 'c1',
        seq: 7,
        surfaceId: 'srf-a',
      });
      writeFileSync(join(dir, 'view-position.json'), '{nope');
      const warns: unknown[] = [];
      const s = new ViewPositionStore({ dataDir: dir, logger: { warn: (...a) => warns.push(a) } });
      expect(s.get()).toBeNull();
      expect(warns).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
