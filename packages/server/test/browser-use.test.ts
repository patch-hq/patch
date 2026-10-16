// Settings → Computer use: GET /api/browser-use reads each online machine's
// status; POST /api/browser-use/:hostId/stop tells one to stop.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { PatchBrowserUseRequestEvent, WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-browser-use-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const user = generateUserKeypair(() => new Uint8Array(32).fill(78));
  const registry = Registry.load(dir);
  registry.bootstrapAccount({ keypair: user });
  registry.upsertSurface({ surfaceId: 'srf-a', surfaceKind: 'web', label: 'web', issuedAt: 1 });
  const jwt = await mintSurfaceCredential({
    userPrivateKey: user.privateKey,
    surfaceId: 'srf-a',
    surfaceKind: 'web',
    label: 'web',
  });
  const hostLink = new InProcessHostLink();
  hostLink.addOnlineHost('host-a');
  const built = await buildAll({
    logger: false as never,
    registry,
    hostLink,
    jobsWatch: false,
    gcalSubscriptions: false,
  });
  const headers = { authorization: `Bearer ${jwt}` };
  const requests = () =>
    hostLink.sent.filter(
      (s): s is { surfaceId: string; hostId?: string; event: PatchBrowserUseRequestEvent } =>
        s.event.type === 'patch.browser_use.request',
    );
  const answer = async (n: number, body: Record<string, unknown>) => {
    for (let i = 0; i < 100 && requests().length < n; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const r of requests()) {
      hostLink.injectHostEvent({
        type: 'patch.browser_use.response',
        requestId: r.event.requestId,
        ...body,
      } as WireEvent);
    }
  };
  return { built, headers, requests, answer };
}

describe('Computer use API', () => {
  it('requires auth', async () => {
    const { built } = await setup();
    try {
      const res = await built.app.inject({ method: 'GET', url: '/api/browser-use' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('reports each online machine’s status', async () => {
    const { built, headers, answer } = await setup();
    try {
      const pending = built.app.inject({ method: 'GET', url: '/api/browser-use', headers });
      await answer(2, { active: true, actionLabel: 'Clicking', since: 5, tabs: 1 });
      const res = await pending;
      expect(res.statusCode).toBe(200);
      const hosts = res.json().hosts as Array<{ hostId: string; active: boolean }>;
      expect(hosts.map((h) => h.hostId).sort()).toEqual(['d1', 'host-a']);
      expect(hosts.every((h) => h.active)).toBe(true);
    } finally {
      await built.app.close();
    }
  });

  it('stop sends a stop request to that machine and returns its answer', async () => {
    const { built, headers, answer, requests } = await setup();
    try {
      const pending = built.app.inject({
        method: 'POST',
        url: '/api/browser-use/host-a/stop',
        headers,
      });
      await answer(1, { active: false, tabs: 0, closed: 2, lastStoppedAt: 9 });
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ hostId: 'host-a', active: false, closed: 2 });
      expect(requests()[0]!.event.action).toBe('stop');
    } finally {
      await built.app.close();
    }
  });

  it('stop on an offline machine is a 409, not a silent success', async () => {
    const { built, headers } = await setup();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/browser-use/nope/stop',
        headers,
      });
      expect(res.statusCode).toBe(409);
    } finally {
      await built.app.close();
    }
  });
});
