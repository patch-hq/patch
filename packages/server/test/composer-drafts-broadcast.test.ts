// Server-owned composer drafts, end to end (spec/14 § Composer, spec/15 §
// Composer): a surface's `composer_draft.set`/`clear` writes straight to the
// server's store (never the host — a chat's host can be asleep) and the
// change fans out to EVERY connected surface, including a cold-start snapshot
// for one that connects after the draft already exists.

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
  const dir = mkdtempSync(join(tmpdir(), 'patch-composer-drafts-e2e-'));
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

describe('composer drafts — surface → server → every other surface', () => {
  it('a set from one surface reaches another as composer_draft.updated', async () => {
    const ctx = await setUp();
    try {
      const a = await ctx.clientFor('srf-a');
      const b = await ctx.clientFor('srf-b');
      try {
        const gotOnB = b.waitFor('composer_draft.updated');
        a.send({ type: 'composer_draft.set', chatId: 'c1', text: 'not sent yet' });
        const event = await gotOnB;
        expect(event).toMatchObject({
          type: 'composer_draft.updated',
          chatId: 'c1',
          text: 'not sent yet',
        });
        expect(typeof (event as { updatedAt: number }).updatedAt).toBe('number');
      } finally {
        await a.close();
        await b.close();
      }
    } finally {
      await cleanUp(ctx);
    }
  });

  it('a clear from one surface reaches another as composer_draft.cleared', async () => {
    const ctx = await setUp();
    try {
      const a = await ctx.clientFor('srf-a');
      const b = await ctx.clientFor('srf-b');
      try {
        a.send({ type: 'composer_draft.set', chatId: 'c1', text: 'hello' });
        await b.waitFor('composer_draft.updated');

        const gotClear = b.waitFor('composer_draft.cleared');
        a.send({ type: 'composer_draft.clear', chatId: 'c1' });
        const event = await gotClear;
        expect(event).toMatchObject({ type: 'composer_draft.cleared', chatId: 'c1' });
      } finally {
        await a.close();
        await b.close();
      }
    } finally {
      await cleanUp(ctx);
    }
  });

  it('setting whitespace-only text broadcasts a clear, not an update with empty text', async () => {
    const ctx = await setUp();
    try {
      const a = await ctx.clientFor('srf-a');
      const b = await ctx.clientFor('srf-b');
      try {
        a.send({ type: 'composer_draft.set', chatId: 'c1', text: 'hello' });
        await b.waitFor('composer_draft.updated');

        const gotClear = b.waitFor('composer_draft.cleared');
        a.send({ type: 'composer_draft.set', chatId: 'c1', text: '   ' });
        const event = await gotClear;
        expect(event).toMatchObject({ type: 'composer_draft.cleared', chatId: 'c1' });
      } finally {
        await a.close();
        await b.close();
      }
    } finally {
      await cleanUp(ctx);
    }
  });

  it('a surface that connects AFTER a draft exists gets it in composer_draft.list right after auth.ok', async () => {
    const ctx = await setUp();
    try {
      const a = await ctx.clientFor('srf-a');
      try {
        a.send({ type: 'composer_draft.set', chatId: 'c1', text: 'seeded before connect' });
        // Give the write a moment to land before the late joiner connects.
        await new Promise((r) => setTimeout(r, 50));

        // The `composer_draft.list` snapshot is sent synchronously right after
        // `auth.ok`, in the same burst — same ordering hazard as
        // `file-changed-broadcast.test.ts`'s `host.online` wait, so the
        // waiter must be registered before connecting, not after.
        const jwtC = await mintSurfaceCredential({
          userPrivateKey: ctx.user.privateKey,
          surfaceId: 'srf-c',
          surfaceKind: 'mobile',
          label: 'srf-c',
        });
        const c = new WireTestClient({ url: ctx.url, auth: jwtC });
        const listPromise = c.waitFor('composer_draft.list');
        await c.connect();
        try {
          const list = await listPromise;
          expect(list).toEqual({
            type: 'composer_draft.list',
            drafts: [
              { chatId: 'c1', text: 'seeded before connect', updatedAt: expect.any(Number) },
            ],
          });
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

  it('a surface connecting with no drafts on the account gets no composer_draft.list frame', async () => {
    const ctx = await setUp();
    try {
      const a = await ctx.clientFor('srf-a');
      try {
        let sawList = false;
        a.on('composer_draft.list', () => {
          sawList = true;
        });
        await new Promise((r) => setTimeout(r, 50));
        expect(sawList).toBe(false);
      } finally {
        await a.close();
      }
    } finally {
      await cleanUp(ctx);
    }
  });

  it('deleting a chat drops its draft and broadcasts the clear to every surface', async () => {
    const ctx = await setUp();
    try {
      const a = await ctx.clientFor('srf-a');
      const b = await ctx.clientFor('srf-b');
      try {
        ctx.hostLink.emit({
          type: 'chat.spawned',
          hostId: 'd1',
          chatId: 'c1',
          folder: '/tmp/x',
        });
        a.send({ type: 'composer_draft.set', chatId: 'c1', text: 'hello' });
        await b.waitFor('composer_draft.updated');

        const gotClear = b.waitFor('composer_draft.cleared');
        const res = await ctx.built.app.inject({
          method: 'DELETE',
          url: '/api/chats/c1',
          headers: { authorization: `Bearer ${await ctx.restJwt()}` },
        });
        expect(res.statusCode).toBe(200);
        const event = await gotClear;
        expect(event).toMatchObject({ type: 'composer_draft.cleared', chatId: 'c1' });
        expect(ctx.built.composerDrafts.get('c1')).toBeUndefined();
      } finally {
        await a.close();
        await b.close();
      }
    } finally {
      await cleanUp(ctx);
    }
  });
  it('sending a message into a chat drops its draft and tells every surface', async () => {
    const ctx = await setUp();
    try {
      const a = await ctx.clientFor('srf-a');
      const b = await ctx.clientFor('srf-b');
      try {
        a.send({ type: 'composer_draft.set', chatId: 'c1', text: 'about to send' });
        await b.waitFor('composer_draft.updated');

        const gotClear = b.waitFor('composer_draft.cleared');
        a.sendInput({ chatId: 'c1', message: 'about to send' });
        const event = await gotClear;
        expect(event).toMatchObject({ type: 'composer_draft.cleared', chatId: 'c1' });
        expect(ctx.built.composerDrafts.get('c1')).toBeUndefined();
      } finally {
        await a.close();
        await b.close();
      }
    } finally {
      await cleanUp(ctx);
    }
  });

  it('a redelivered chat.input (same localId) does not clear a newer draft', async () => {
    const ctx = await setUp();
    try {
      const a = await ctx.clientFor('srf-a');
      const b = await ctx.clientFor('srf-b');
      try {
        a.send({ type: 'composer_draft.set', chatId: 'c1', text: 'first' });
        await b.waitFor('composer_draft.updated');
        const firstClear = b.waitFor('composer_draft.cleared');
        a.sendInput({ chatId: 'c1', message: 'first', localId: 'redeliver-1' });
        await firstClear;

        // The user starts a new draft, then the surface's retry lands.
        const gotNew = b.waitFor('composer_draft.updated');
        a.send({ type: 'composer_draft.set', chatId: 'c1', text: 'typed since' });
        await gotNew;
        a.sendInput({ chatId: 'c1', message: 'first', localId: 'redeliver-1' });
        // Barrier: a later frame on the same socket is processed after the retry.
        const barrier = b.waitFor('composer_draft.updated');
        a.send({ type: 'composer_draft.set', chatId: 'c2', text: 'barrier' });
        await barrier;

        expect(ctx.built.composerDrafts.get('c1')?.text).toBe('typed since');
      } finally {
        await a.close();
        await b.close();
      }
    } finally {
      await cleanUp(ctx);
    }
  });
});
