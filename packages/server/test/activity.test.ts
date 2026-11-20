// `patch_activity` reads the server's chat record (spec/06 § Cross-chat
// toolset): GET /api/activity and the daemon-facing `patch.activity.request`
// both read the user messages the record holds and join them against the chat
// index. No host is asked, so a chat on an offline host is answered for too.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-activity-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Seed the server's dwell log (`activity.jsonl`) before it is built: surface s1 sits on c-a, then c-b. */
function seedDwell(base: number): void {
  const events = [
    { kind: 'visibility', ts: base, surfaceId: 's1', visible: true },
    { kind: 'focus', ts: base, surfaceId: 's1', chatId: 'c-a' },
    { kind: 'focus', ts: base + 1000, surfaceId: 's1', chatId: 'c-b' },
    { kind: 'focus', ts: base + 1500, surfaceId: 's1', chatId: 'gone' },
    { kind: 'visibility', ts: base + 2000, surfaceId: 's1', visible: false },
  ];
  writeFileSync(
    join(dir, 'activity.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

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
  const seqs = new Map<string, number>();
  /** Put user messages into the server's record, as each host's outbox would. */
  const seed = (
    rows: Array<{
      chatId: string;
      text: string;
      ts: number;
      extra?: Record<string, unknown>;
    }>,
  ) => {
    for (const r of rows) {
      const seq = seqs.get(r.chatId) ?? 0;
      seqs.set(r.chatId, seq + 1);
      built.chatLogStore.commit({
        type: 'chat.message',
        chatId: r.chatId,
        seq,
        role: 'user',
        content: r.text,
        createdAt: r.ts,
        ...r.extra,
      } as WireEvent);
    }
  };
  return { built, hostLink, get, seed };
}

describe('GET /api/activity', () => {
  it('reads every chat’s user messages from the record, oldest first, enriched from the index, with no chatSessions', async () => {
    const { built, hostLink, get, seed } = await setup();
    try {
      seed([
        { chatId: 'c-a', text: 'second', ts: 3000 },
        { chatId: 'c-b', text: 'first', ts: 2000 },
      ]);
      // A host being offline changes nothing: no host is asked.
      hostLink.dropOnlineHost('host-b');
      const res = await get('since=1000&until=9000');
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
      expect(hostLink.sent.filter((s) => s.event.type.startsWith('patch.activity'))).toEqual([]);
    } finally {
      await built.app.close();
    }
  });

  it('only counts user messages, and says what produced the ones no person typed', async () => {
    const { built, get, seed } = await setup();
    try {
      seed([
        { chatId: 'c-b', text: 'typed by hand', ts: 2000 },
        { chatId: 'c-a', text: 'a nudge', ts: 3000, extra: { origin: 'machine' } },
        { chatId: 'c-a', text: 'job fire', ts: 3100, extra: { jobTrigger: true } },
        { chatId: 'c-a', text: 'reply', ts: 3200, extra: { role: 'assistant' } },
      ]);
      const res = await get('since=1000&until=9000');
      expect(res.json()).toMatchObject({
        messages: [
          { chatId: 'c-b', text: 'typed by hand', ts: 2000 },
          { chatId: 'c-a', text: 'a nudge', ts: 3000, kind: 'machine' },
          { chatId: 'c-a', text: 'job fire', ts: 3100, kind: 'job' },
        ],
      });
      expect(res.json().messages).toHaveLength(3);
      expect('kind' in res.json().messages[0]).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('marks a turn re-sent after a restart note as machine-made', async () => {
    const { built, get, seed } = await setup();
    try {
      seed([{ chatId: 'c-a', text: 'start', ts: 1000 }]);
      built.chatLogStore.commit({
        type: 'chat.note',
        chatId: 'c-a',
        seq: 1,
        label: 'Turn interrupted by restart',
      } as WireEvent);
      built.chatLogStore.commit({
        type: 'chat.message',
        chatId: 'c-a',
        seq: 2,
        role: 'user',
        content: 'Carry on',
        createdAt: 2000,
      } as WireEvent);
      const res = await get('since=0&until=9000');
      expect(res.json().messages.map((m: { kind?: string }) => m.kind ?? 'person')).toEqual([
        'person',
        'machine',
      ]);
    } finally {
      await built.app.close();
    }
  });

  it('truncates at limit and resumes from the cursor; drops chats the index does not know', async () => {
    const { built, get, seed } = await setup();
    try {
      seed([
        { chatId: 'c-a', text: 'one', ts: 1000 },
        { chatId: 'gone', text: 'ghost', ts: 1500 },
        { chatId: 'c-a', text: 'three', ts: 3000 },
      ]);
      const body = (await get('since=0&until=9000&limit=2')).json() as {
        messages: Array<{ text: string }>;
        messagesTruncated: boolean;
        nextMessagesCursor: number;
      };
      expect(body.messages.map((m) => m.text)).toEqual(['one']);
      expect(body.messagesTruncated).toBe(true);
      expect(body.nextMessagesCursor).toBe(1501);
      const next = (await get(`since=0&until=9000&limit=2&messagesCursor=1501`)).json() as {
        messages: Array<{ text: string }>;
        messagesTruncated: boolean;
      };
      expect(next.messages.map((m) => m.text)).toEqual(['three']);
      expect(next.messagesTruncated).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('never ends a page inside a run of equal timestamps, so the next page loses none of it', async () => {
    const { built, get, seed } = await setup();
    try {
      seed([
        { chatId: 'c-a', text: 'one', ts: 1000 },
        { chatId: 'c-a', text: 'two-a', ts: 2000 },
        { chatId: 'c-b', text: 'two-b', ts: 2000 },
      ]);
      const body = (await get('since=0&until=9000&limit=2')).json() as {
        messages: Array<{ text: string }>;
        messagesTruncated: boolean;
        nextMessagesCursor: number;
      };
      expect(body.messages.map((m) => m.text)).toEqual(['one']);
      expect(body.messagesTruncated).toBe(true);
      // The read takes `ts >= since`: resuming AT 2000 picks up both.
      expect(body.nextMessagesCursor).toBe(2000);
    } finally {
      await built.app.close();
    }
  });

  it('returns the whole run when equal timestamps fill the page, then moves past it', async () => {
    const { built, get, seed } = await setup();
    try {
      seed([
        { chatId: 'c-a', text: 'a', ts: 2000 },
        { chatId: 'c-b', text: 'b', ts: 2000 },
      ]);
      const body = (await get('since=0&until=9000&limit=1')).json() as {
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

  it('clamps the window to 30 days', async () => {
    const { built, get, seed } = await setup();
    try {
      const until = Date.now();
      seed([
        { chatId: 'c-a', text: 'too old', ts: until - 31 * 24 * 60 * 60 * 1000 },
        { chatId: 'c-a', text: 'recent', ts: until - 1000 },
      ]);
      const body = (await get(`since=0&until=${until}&limit=10`)).json();
      expect(body.messages.map((m: { text: string }) => m.text)).toEqual(['recent']);
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
  it('answers the asking host with a patch.activity.response', async () => {
    const { built, hostLink, seed } = await setup();
    try {
      seed([{ chatId: 'c-a', text: 'hi', ts: 2000 }]);
      hostLink.injectHostEvent({
        type: 'patch.activity.request',
        sourceChatId: 'caller',
        since: 1000,
        until: 9000,
      } as WireEvent);
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

describe('chat dwell sessions (opt-in)', () => {
  it('GET /api/activity?includeSessions=true adds server-recorded sessions, enriched, dropping chats the index does not know', async () => {
    const base = Date.now() - 60_000;
    seedDwell(base);
    const { built, get } = await setup();
    try {
      const res = await get(`since=${base}&until=${base + 5000}&includeSessions=true`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        messages: [],
        messagesTruncated: false,
        chatSessions: [
          {
            chatId: 'c-a',
            chatName: null,
            hostId: 'host-a',
            folder: '/work/c-a',
            start: base,
            end: base + 1000,
            durationMs: 1000,
          },
          {
            chatId: 'c-b',
            chatName: null,
            hostId: 'host-b',
            folder: '/work/c-b',
            start: base + 1000,
            end: base + 1500,
            durationMs: 500,
          },
        ],
        sessionsTruncated: false,
      });
    } finally {
      await built.app.close();
    }
  });

  it('pages sessions with sessionsCursor (which implies includeSessions) independently of messages', async () => {
    const base = Date.now() - 60_000;
    seedDwell(base);
    const { built, get } = await setup();
    try {
      const page1 = (
        await get(`since=${base}&until=${base + 5000}&includeSessions=true&limit=1`)
      ).json();
      expect(page1.chatSessions.map((c: { chatId: string }) => c.chatId)).toEqual(['c-a']);
      expect(page1.sessionsTruncated).toBe(true);
      expect(page1.nextSessionsCursor).toBe(base + 1);

      const page2 = (
        await get(
          `since=${base}&until=${base + 5000}&limit=1&sessionsCursor=${page1.nextSessionsCursor}`,
        )
      ).json();
      expect(page2.chatSessions.map((c: { chatId: string }) => c.chatId)).toEqual(['c-b']);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a non-numeric sessionsCursor', async () => {
    const { built, get } = await setup();
    try {
      expect((await get('since=0&until=10&sessionsCursor=x')).statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('a host that sets includeSessions on patch.activity.request gets chatSessions back', async () => {
    const base = Date.now() - 60_000;
    seedDwell(base);
    const { built, hostLink } = await setup();
    try {
      hostLink.injectHostEvent({
        type: 'patch.activity.request',
        sourceChatId: 'new-host',
        since: base,
        until: base + 5000,
        includeSessions: true,
      } as WireEvent);
      for (
        let i = 0;
        i < 100 && !hostLink.sent.some((s) => s.event.type === 'patch.activity.response');
        i++
      ) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const withSessions = hostLink.sent.find(
        (s) => s.event.type === 'patch.activity.response',
      )!.event;
      expect(withSessions).toMatchObject({
        sessionsTruncated: false,
        chatSessions: [{ chatId: 'c-a' }, { chatId: 'c-b' }],
      });
    } finally {
      await built.app.close();
    }
  });

  it('asking for sessions with no log fails rather than returning an empty list', async () => {
    const { createActivityReader } = await import('../src/activity.js');
    const { ChatRegistry } = await import('../src/chat-registry.js');
    const { ChatLogStore } = await import('../src/chat-log-store.js');
    const reader = createActivityReader({
      chatLogStore: new ChatLogStore({ logger: { warn: () => undefined } }),
      chatRegistry: new ChatRegistry(),
    });
    await expect(reader.query({ since: 0, until: 10, includeSessions: true })).rejects.toThrow(
      /sessions are not recorded/,
    );
  });
});
