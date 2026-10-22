// Settings → Usage: GET /api/usage-report fans out `patch.usage.read.request`
// to every online machine and merges samples and per-chat tokens.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { PatchUsageReadRequestEvent, WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

const ONLINE_HOSTS = ['d1', 'host-a', 'host-b'];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-usage-report-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const user = generateUserKeypair(() => new Uint8Array(32).fill(77));
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
  hostLink.addOnlineHost('host-b');
  const built = await buildAll({
    logger: false as never,
    registry,
    hostLink,
    jobsWatch: false,
    gcalSubscriptions: false,
  });
  const get = (qs: string) =>
    built.app.inject({
      method: 'GET',
      url: `/api/usage-report?${qs}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
  const readRequests = (): Array<{ hostId?: string; event: PatchUsageReadRequestEvent }> =>
    hostLink.sent.filter(
      (s): s is { surfaceId: string; hostId?: string; event: PatchUsageReadRequestEvent } =>
        s.event.type === 'patch.usage.read.request',
    );
  const answerAll = async (
    byHost: Record<string, { samples: unknown[]; chats: unknown[] }>,
    skip: string[] = [],
  ) => {
    const want = ONLINE_HOSTS.length;
    for (let i = 0; i < 100 && readRequests().length < want; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const r of readRequests()) {
      if (skip.includes(r.hostId!)) continue;
      hostLink.injectHostEvent({
        type: 'patch.usage.read.response',
        requestId: r.event.requestId,
        hostId: r.hostId,
        ...(byHost[r.hostId!] ?? { samples: [], chats: [] }),
      } as WireEvent);
    }
  };
  return { built, hostLink, get, readRequests, answerAll };
}

describe('GET /api/usage-report', () => {
  it('merges samples oldest first and chats biggest first, each carrying its host', async () => {
    const { built, get, answerAll } = await setup();
    try {
      const pending = get('since=1000&until=9000');
      await answerAll({
        'host-a': {
          samples: [{ ts: 3000, accountId: 'a', label: 'A', week: 0.5 }],
          chats: [{ chatId: 'c1', tokens: 10, costUsd: 0, turns: 1 }],
        },
        'host-b': {
          samples: [{ ts: 2000, accountId: 'b', label: 'B', week: 0.1 }],
          chats: [{ chatId: 'c2', tokens: 99, costUsd: 0, turns: 2 }],
        },
      });
      const res = await pending;
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.samples.map((s: { ts: number; hostId: string }) => [s.ts, s.hostId])).toEqual([
        [2000, 'host-b'],
        [3000, 'host-a'],
      ]);
      expect(body.chats.map((c: { chatId: string }) => c.chatId)).toEqual(['c2', 'c1']);
    } finally {
      await built.app.close();
    }
  });

  it('answers a named period from its cache after the first read, and says when it was read', async () => {
    const { built, get, answerAll, readRequests } = await setup();
    try {
      const first = get('period=day');
      await answerAll({
        'host-a': {
          samples: [{ ts: Date.now() - 1000, accountId: 'a', label: 'A', week: 0.5 }],
          chats: [],
        },
      });
      const body = (await first).json();
      expect(body.samples).toHaveLength(1);
      expect(body.until - body.since).toBe(24 * 60 * 60 * 1000);
      expect(typeof body.at).toBe('number');
      const asked = readRequests().length;
      // Within the TTL: the same answer, and nothing asked of any machine.
      const second = await get('period=day');
      expect(second.statusCode).toBe(200);
      expect(second.json().at).toBe(body.at);
      expect(readRequests().length).toBe(asked);
    } finally {
      await built.app.close();
    }
  });

  it('refuses a period it does not keep', async () => {
    const { built, get } = await setup();
    try {
      expect((await get('period=year')).statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('rejects non-numeric bounds', async () => {
    const { built, get } = await setup();
    try {
      expect((await get('since=abc')).statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('requires authentication', async () => {
    const { built } = await setup();
    try {
      const res = await built.app.inject({ method: 'GET', url: '/api/usage-report' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });
});
