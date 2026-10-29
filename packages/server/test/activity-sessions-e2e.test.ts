// Dwell sessions end-to-end: a real surface WebSocket sends chat.focus_change /
// surface.foregrounded / surface.backgrounded, ws-hub records them, and
// GET /api/activity?includeSessions=true reports what was recorded. Complements
// activity-log.test.ts (the dwell maths) and activity.test.ts (the read path).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import type { PatchActivityReadRequestEvent, WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-activity-e2e-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const user = generateUserKeypair(() => new Uint8Array(32).fill(77));
  const registry = Registry.load(dir);
  registry.bootstrapAccount({ keypair: user });
  registry.upsertSurface({ surfaceId: 'srf-e2e', surfaceKind: 'web', label: 'web', issuedAt: 1 });
  const surfaceJwt = await mintSurfaceCredential({
    userPrivateKey: user.privateKey,
    surfaceId: 'srf-e2e',
    surfaceKind: 'web',
    label: 'web',
  });
  const hostLink = new InProcessHostLink();
  const built = await buildAll({
    logger: false as never,
    registry,
    hostLink,
    jobsWatch: false,
    gcalSubscriptions: false,
  });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const url = `ws://127.0.0.1:${(built.app.server.address() as AddressInfo).port}/ws`;
  const client = new WireTestClient({ url, auth: surfaceJwt });
  await client.connect();
  await client.waitFor('auth.ok');
  const getSessions = async (since: number, until: number) => {
    const pending = built.app.inject({
      method: 'GET',
      url: `/api/activity?since=${since}&until=${until}&includeSessions=true`,
      headers: { authorization: `Bearer ${surfaceJwt}` },
    });
    // Every online host is asked for its messages; none has any.
    const answered = new Set<string>();
    for (let i = 0; i < 100; i++) {
      for (const s of hostLink.sent) {
        if (s.event.type !== 'patch.activity.read.request') continue;
        const { requestId } = s.event as PatchActivityReadRequestEvent;
        if (answered.has(requestId)) continue;
        answered.add(requestId);
        hostLink.injectHostEvent({
          type: 'patch.activity.read.response',
          requestId,
          messages: [],
        } as WireEvent);
      }
      if (answered.size > 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    return pending;
  };
  return { built, client, getSessions };
}

describe('dwell sessions end-to-end (real WS surface → GET /api/activity)', () => {
  it('reports a session for a chat the mirror knows, from real focus + foreground/background frames', async () => {
    const { built, client, getSessions } = await setup();
    try {
      built.chatRegistry.observe({
        type: 'chat.spawned',
        chatId: 'chat-known-1',
        hostId: 'host-e2e',
        folder: '/home/user/project',
      } as never);
      const since = Date.now();
      client.send({ type: 'surface.foregrounded' });
      client.send({ type: 'chat.focus_change', chatId: 'chat-known-1' });
      await new Promise((r) => setTimeout(r, 30));
      client.send({ type: 'surface.backgrounded' });
      await new Promise((r) => setTimeout(r, 30));
      const until = Date.now();

      const res = await getSessions(since, until);
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        chatSessions: { chatId: string; hostId: string; folder: string; durationMs: number }[];
      };
      expect(body.chatSessions).toHaveLength(1);
      expect(body.chatSessions[0]).toMatchObject({
        chatId: 'chat-known-1',
        hostId: 'host-e2e',
        folder: '/home/user/project',
      });
      // Closed by the background frame, not left running to `until`.
      expect(body.chatSessions[0]!.durationMs).toBeLessThan(until - since);
    } finally {
      await client.close();
      await built.app.close();
    }
  });

  it('focused but never foregrounded is not a session', async () => {
    const { built, client, getSessions } = await setup();
    try {
      built.chatRegistry.observe({
        type: 'chat.spawned',
        chatId: 'chat-bg',
        hostId: 'host-e2e',
        folder: '/home/user/project',
      } as never);
      const since = Date.now();
      client.send({ type: 'surface.backgrounded' });
      client.send({ type: 'chat.focus_change', chatId: 'chat-bg' });
      await new Promise((r) => setTimeout(r, 30));
      const res = await getSessions(since, Date.now());
      expect(res.json().chatSessions).toEqual([]);
    } finally {
      await client.close();
      await built.app.close();
    }
  });
});
