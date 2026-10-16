// Settings → Activity ("things agents did"): GET /api/tool-log fans out
// `patch.tool_log.read.request` to every online machine and merges the
// answers, same shape as `activity.test.ts`'s `/api/activity`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { PatchToolLogReadRequestEvent, WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

const ONLINE_HOSTS = ['d1', 'host-a', 'host-b'];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-tool-log-'));
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
      url: `/api/tool-log?${qs}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
  const readRequests = (): Array<{ hostId?: string; event: PatchToolLogReadRequestEvent }> =>
    hostLink.sent.filter(
      (s): s is { surfaceId: string; hostId?: string; event: PatchToolLogReadRequestEvent } =>
        s.event.type === 'patch.tool_log.read.request',
    );
  const answerAll = async (
    byHost: Record<
      string,
      Array<{
        ts: number;
        tool: string;
        callerChatId?: string;
        targetChatId?: string;
        durationMs: number;
        ok: boolean;
        err?: string;
      }>
    >,
  ) => {
    for (let i = 0; i < 100 && readRequests().length < ONLINE_HOSTS.length; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const r of readRequests()) {
      hostLink.injectHostEvent({
        type: 'patch.tool_log.read.response',
        requestId: r.event.requestId,
        hostId: r.hostId,
        entries: byHost[r.hostId!] ?? [],
      } as WireEvent);
    }
  };
  return { built, hostLink, get, readRequests, answerAll };
}

describe('GET /api/tool-log', () => {
  it('merges every online machine’s tool-call log, oldest first, each entry carrying its host', async () => {
    const { built, get, answerAll, readRequests } = await setup();
    try {
      const pending = get('since=1000&until=9000');
      await answerAll({
        'host-a': [
          { ts: 3000, tool: 'patch_send_to', targetChatId: 'c-2', durationMs: 5, ok: true },
        ],
        'host-b': [
          {
            ts: 2000,
            tool: 'patch_peek',
            callerChatId: 'c-1',
            targetChatId: 'c-2',
            durationMs: 3,
            ok: true,
          },
        ],
      });
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        entries: [
          {
            ts: 2000,
            tool: 'patch_peek',
            callerChatId: 'c-1',
            targetChatId: 'c-2',
            durationMs: 3,
            ok: true,
            hostId: 'host-b',
          },
          {
            ts: 3000,
            tool: 'patch_send_to',
            targetChatId: 'c-2',
            durationMs: 5,
            ok: true,
            hostId: 'host-a',
          },
        ],
        truncated: false,
      });
      expect(
        readRequests()
          .map((r) => r.hostId)
          .sort(),
      ).toEqual(ONLINE_HOSTS.slice().sort());
    } finally {
      await built.app.close();
    }
  });

  it('truncates at limit and resumes from the cursor', async () => {
    const { built, get, answerAll } = await setup();
    try {
      const pending = get('since=0&until=9000&limit=1');
      await answerAll({
        'host-a': [
          { ts: 1000, tool: 'patch_peek', durationMs: 1, ok: true },
          { ts: 3000, tool: 'patch_send_to', durationMs: 2, ok: false, err: 'rate_limited' },
        ],
      });
      const body = (await pending).json() as {
        entries: Array<{ tool: string }>;
        truncated: boolean;
        nextCursor: number;
      };
      expect(body.entries.map((e) => e.tool)).toEqual(['patch_peek']);
      expect(body.truncated).toBe(true);
      // `+1`: the next page must not re-include the last entry returned.
      expect(body.nextCursor).toBe(1001);
    } finally {
      await built.app.close();
    }
  });

  it('rejects non-numeric input and unauthenticated callers', async () => {
    const { built, get } = await setup();
    try {
      expect((await get('since=abc')).statusCode).toBe(400);
      const res = await built.app.inject({ method: 'GET', url: '/api/tool-log' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });
});
