// `patch_activity` reads through the chats' own logs on every online machine
// (spec/06 § Cross-chat toolset): GET /api/activity and the daemon-facing
// `patch.activity.request` both fan out `patch.activity.read.request` frames,
// merge the answers and join them against the chat mirror.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { PatchActivityReadRequestEvent, WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

// `d1` is the stand-in link's own machine; the two added hosts join it.
const ONLINE_HOSTS = ['d1', 'host-a', 'host-b'];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-activity-'));
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
  for (const [chatId, hostId] of [
    ['c-a', 'host-a'],
    ['c-b', 'host-b'],
  ] as const) {
    built.chatRegistry.observe({
      type: 'chat.spawned',
      chatId,
      hostId,
      folder: `/work/${chatId}`,
    } as never);
  }
  const get = (qs: string) =>
    built.app.inject({
      method: 'GET',
      url: `/api/activity?${qs}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
  const readRequests = (): Array<{ hostId?: string; event: PatchActivityReadRequestEvent }> =>
    hostLink.sent.filter(
      (s): s is { surfaceId: string; hostId?: string; event: PatchActivityReadRequestEvent } =>
        s.event.type === 'patch.activity.read.request',
    );
  const answerAll = async (
    byHost: Record<
      string,
      Array<{
        chatId: string;
        text: string;
        ts: number;
        kind?: 'job' | 'hook' | 'goal' | 'machine';
      }>
    >,
  ) => {
    for (let i = 0; i < 100 && readRequests().length < ONLINE_HOSTS.length; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const r of readRequests()) {
      hostLink.injectHostEvent({
        type: 'patch.activity.read.response',
        requestId: r.event.requestId,
        messages: byHost[r.hostId!] ?? [],
      } as WireEvent);
    }
  };
  return { built, hostLink, get, readRequests, answerAll };
}

describe('GET /api/activity', () => {
  it('merges every online machine’s user messages, oldest first, enriched from the mirror, with no chatSessions', async () => {
    const { built, get, answerAll, readRequests } = await setup();
    try {
      const pending = get('since=1000&until=9000');
      await answerAll({
        'host-a': [{ chatId: 'c-a', text: 'second', ts: 3000 }],
        'host-b': [{ chatId: 'c-b', text: 'first', ts: 2000 }],
      });
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        messages: [
          {
            chatId: 'c-b',
            chatName: null,
            hostId: 'host-b',
            folder: '/work/c-b',
            text: 'first',
            ts: 2000,
          },
          {
            chatId: 'c-a',
            chatName: null,
            hostId: 'host-a',
            folder: '/work/c-a',
            text: 'second',
            ts: 3000,
          },
        ],
        messagesTruncated: false,
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

  it('carries a host-reported kind through the join untouched, and omits it when absent', async () => {
    const { built, get, answerAll } = await setup();
    try {
      const pending = get('since=1000&until=9000');
      await answerAll({
        'host-a': [{ chatId: 'c-a', text: 'a nudge', ts: 3000, kind: 'machine' }],
        'host-b': [{ chatId: 'c-b', text: 'typed by hand', ts: 2000 }],
      });
      const res = await pending;
      expect(res.json()).toMatchObject({
        messages: [
          { chatId: 'c-b', text: 'typed by hand', ts: 2000 },
          { chatId: 'c-a', text: 'a nudge', ts: 3000, kind: 'machine' },
        ],
      });
      expect('kind' in res.json().messages[0]).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('truncates at limit and resumes from the cursor; drops chats the mirror does not know', async () => {
    const { built, get, answerAll } = await setup();
    try {
      const pending = get('since=0&until=9000&limit=2');
      await answerAll({
        'host-a': [
          { chatId: 'c-a', text: 'one', ts: 1000 },
          { chatId: 'gone', text: 'ghost', ts: 1500 },
          { chatId: 'c-a', text: 'three', ts: 3000 },
        ],
      });
      const body = (await pending).json() as {
        messages: Array<{ text: string }>;
        messagesTruncated: boolean;
        nextMessagesCursor: number;
      };
      expect(body.messages.map((m) => m.text)).toEqual(['one']);
      expect(body.messagesTruncated).toBe(true);
      expect(body.nextMessagesCursor).toBe(1501);
    } finally {
      await built.app.close();
    }
  });

  it('never ends a page inside a run of equal timestamps, so the next page loses none of it', async () => {
    const { built, get, answerAll } = await setup();
    try {
      const pending = get('since=0&until=9000&limit=2');
      await answerAll({
        'host-a': [
          { chatId: 'c-a', text: 'one', ts: 1000 },
          { chatId: 'c-a', text: 'two-a', ts: 2000 },
        ],
        'host-b': [{ chatId: 'c-b', text: 'two-b', ts: 2000 }],
      });
      const body = (await pending).json() as {
        messages: Array<{ text: string }>;
        messagesTruncated: boolean;
        nextMessagesCursor: number;
      };
      expect(body.messages.map((m) => m.text)).toEqual(['one']);
      expect(body.messagesTruncated).toBe(true);
      // The host reads `ts >= since`: resuming AT 2000 picks up both.
      expect(body.nextMessagesCursor).toBe(2000);
    } finally {
      await built.app.close();
    }
  });

  it('returns the whole run when equal timestamps fill the page, then moves past it', async () => {
    const { built, hostLink, get, answerAll, readRequests } = await setup();
    try {
      const pending = get('since=0&until=9000&limit=1');
      const run = {
        'host-a': [{ chatId: 'c-a', text: 'a', ts: 2000 }],
        'host-b': [{ chatId: 'c-b', text: 'b', ts: 2000 }],
      };
      await answerAll(run);
      // A second read for the run itself: exactly that instant, uncapped.
      for (let i = 0; i < 100 && readRequests().length < 2 * ONLINE_HOSTS.length; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const second = readRequests().slice(ONLINE_HOSTS.length);
      expect(second).toHaveLength(ONLINE_HOSTS.length);
      for (const r of second) {
        expect([r.event.since, r.event.until]).toEqual([2000, 2000]);
        hostLink.injectHostEvent({
          type: 'patch.activity.read.response',
          requestId: r.event.requestId,
          messages: run[r.hostId as keyof typeof run] ?? [],
        } as WireEvent);
      }
      const body = (await pending).json() as {
        messages: Array<{ text: string }>;
        messagesTruncated: boolean;
        nextMessagesCursor: number;
      };
      expect(body.messages.map((m) => m.text).sort()).toEqual(['a', 'b']);
      expect(body.messagesTruncated).toBe(true);
      expect(body.nextMessagesCursor).toBe(2001);
    } finally {
      await built.app.close();
    }
  });

  it('clamps the window to 30 days and asks each machine for limit+1 rows', async () => {
    const { built, get, answerAll, readRequests } = await setup();
    try {
      const until = Date.now();
      const pending = get(`since=0&until=${until}&limit=10`);
      await answerAll({});
      await pending;
      const req = readRequests()[0]!.event;
      expect(req.until - req.since).toBe(30 * 24 * 60 * 60 * 1000);
      expect(req.limit).toBe(11);
    } finally {
      await built.app.close();
    }
  });

  it('rejects non-numeric input and unauthenticated callers', async () => {
    const { built, get } = await setup();
    try {
      expect((await get('since=abc')).statusCode).toBe(400);
      const res = await built.app.inject({ method: 'GET', url: '/api/activity' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });
});

describe('patch.activity.request (a host’s patch_activity)', () => {
  it('answers the asking machine with a patch.activity.response', async () => {
    const { built, hostLink, answerAll } = await setup();
    try {
      hostLink.injectHostEvent({
        type: 'patch.activity.request',
        sourceChatId: 'caller',
        since: 1000,
        until: 9000,
      } as WireEvent);
      await answerAll({ 'host-a': [{ chatId: 'c-a', text: 'hi', ts: 2000 }] });
      for (
        let i = 0;
        i < 100 && !hostLink.sent.some((s) => s.event.type === 'patch.activity.response');
        i++
      ) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const reply = hostLink.sent.find((s) => s.event.type === 'patch.activity.response')!.event;
      expect(reply).toMatchObject({
        type: 'patch.activity.response',
        sourceChatId: 'caller',
        messagesTruncated: false,
        messages: [{ chatId: 'c-a', text: 'hi', ts: 2000 }],
      });
      expect('chatSessions' in reply).toBe(false);
    } finally {
      await built.app.close();
    }
  });
});

describe('read retry', () => {
  it('retries a machine that was silent for one attempt, and still fails if it stays silent', async () => {
    const { createActivityReader } = await import('../src/activity.js');
    const { ChatRegistry } = await import('../src/chat-registry.js');
    const hostLink = new InProcessHostLink();
    const reader = createActivityReader({
      hostLink,
      chatRegistry: new ChatRegistry(),
      readTimeoutMs: 20,
    });
    const reqs = () => hostLink.sent.filter((s) => s.event.type === 'patch.activity.read.request');
    const answerLatest = () =>
      hostLink.injectHostEvent({
        type: 'patch.activity.read.response',
        requestId: (reqs().at(-1)!.event as PatchActivityReadRequestEvent).requestId,
        messages: [],
      } as WireEvent);
    const ok = reader.query({ since: 0, until: 1000 });
    await new Promise((r) => setTimeout(r, 40)); // first attempt times out unanswered
    expect(reqs().length).toBe(2);
    answerLatest();
    await expect(ok).resolves.toMatchObject({ messagesTruncated: false });
    const dead = reader.query({ since: 0, until: 1000 });
    await expect(dead).rejects.toThrow(/did not answer/);
    reader.close();
  });
});
