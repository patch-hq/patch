// Settings → Activity ("things agents did"): each host sends its cross-chat
// tool calls through its outbox (`patch.tool_log.entry`) and the server keeps
// them, so GET /api/tool-log reads the same whether or not a host is online.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { ToolLogEntry, WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';
import { ToolLog } from '../src/tool-log.js';

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
  /** A host sending one entry, as its outbox would. */
  const send = (hostId: string, entry: ToolLogEntry) => {
    hostLink.setHostId(hostId);
    hostLink.injectHostEvent({ type: 'patch.tool_log.entry', entry } as WireEvent);
  };
  return { built, hostLink, get, send };
}

describe('GET /api/tool-log', () => {
  it('reads every host’s entries from the server’s log, oldest first, each carrying its host', async () => {
    const { built, hostLink, get, send } = await setup();
    try {
      send('host-a', {
        ts: 3000,
        tool: 'patch_send_to',
        callerChatId: 'c1',
        targetChatId: 'c2',
        durationMs: 5,
        ok: true,
      });
      send('host-b', {
        ts: 2000,
        tool: 'patch_peek',
        targetChatId: 'c3',
        durationMs: 4,
        ok: false,
        err: 'chat_not_found',
      });
      // No host is asked: the log reads the same with every host gone.
      hostLink.setStatus('offline');
      const res = await get('since=1000&until=9000');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        entries: [
          {
            ts: 2000,
            tool: 'patch_peek',
            targetChatId: 'c3',
            durationMs: 4,
            ok: false,
            err: 'chat_not_found',
            hostId: 'host-b',
          },
          {
            ts: 3000,
            tool: 'patch_send_to',
            callerChatId: 'c1',
            targetChatId: 'c2',
            durationMs: 5,
            ok: true,
            hostId: 'host-a',
          },
        ],
        truncated: false,
      });
      expect(readFileSync(join(dir, 'tool-calls.jsonl'), 'utf8').trim().split('\n')).toHaveLength(
        2,
      );
    } finally {
      await built.app.close();
    }
  });

  it('truncates at limit and resumes from the cursor', async () => {
    const { built, get, send } = await setup();
    try {
      for (const ts of [1000, 2000, 3000]) {
        send('host-a', { ts, tool: 'patch_peek', durationMs: 1, ok: true });
      }
      const first = (await get('since=0&until=9000&limit=2')).json();
      expect(first.entries.map((e: { ts: number }) => e.ts)).toEqual([1000, 2000]);
      expect(first.truncated).toBe(true);
      expect(first.nextCursor).toBe(2001);
      const second = (await get(`since=0&until=9000&limit=2&cursor=${first.nextCursor}`)).json();
      expect(second.entries.map((e: { ts: number }) => e.ts)).toEqual([3000]);
      expect(second.truncated).toBe(false);
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

describe('ToolLog', () => {
  it('keeps only its newest entries once the file passes its size cap', () => {
    const log = new ToolLog({
      dataDir: dir,
      logger: { warn: () => undefined },
      maxFileBytes: 200,
      keepEntries: 2,
      now: () => 10_000,
    });
    for (let i = 0; i < 10; i++) {
      log.append({ ts: 1000 + i, tool: 'patch_peek', durationMs: 1, ok: true, hostId: 'h' });
    }
    const all = log.query({ since: 0, until: 10_000 });
    expect(all.entries.length).toBeLessThanOrEqual(3);
    expect(all.entries.at(-1)!.ts).toBe(1009);
  });

  it('ignores frames from no host', () => {
    const log = new ToolLog({ logger: { warn: () => undefined } });
    log.observe(
      { type: 'patch.tool_log.entry', entry: { ts: 1, tool: 'x', durationMs: 0, ok: true } },
      null,
    );
    expect(log.query({ since: 0, until: 10 }).entries).toEqual([]);
  });
});
