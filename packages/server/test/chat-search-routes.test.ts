// Chat search REST (spec/03 § Chat search).
//
// The server searches every chat itself — names, the stored first-message
// preview and the message text in its record — whichever host the chat is on
// and whether or not that host is online. No host is ever asked. Results are
// ranked under the one shared ordering (most recently active first) and paged,
// and every host is named with how many of its chats were searched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { ChatSearchResponse, type WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';
import { ChatLogStore } from '../src/chat-log-store.js';

describe('chat search route', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-chat-search-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Three registered hosts: d1 (home) and mac online, pi offline. */
  async function boot(link = new InProcessHostLink()) {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(44));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'web', issuedAt: 1 });
    for (const id of ['d1', 'mac', 'pi']) {
      registry.setDaemonKey({ hostId: id, publicKey: user.publicKey, issuedAt: 1 });
    }
    registry.setHostName('mac', 'MacBook');
    link.addOnlineHost('mac');
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-web',
      surfaceKind: 'web',
      label: 'web',
    });
    const built = await buildAll({ logger: false, registry, hostLink: link });
    const auth = { authorization: `Bearer ${jwt}` };
    const get = async (qs: string) =>
      built.app.inject({ method: 'GET', url: `/api/chats/search?${qs}`, headers: auth });
    const body = async (qs: string) => ChatSearchResponse.parse((await get(qs)).json());
    /** A chat on `hostId`, with its index entry and what it said. */
    const chat = (
      chatId: string,
      hostId: string,
      opts: {
        name?: string;
        lastUpdated?: number;
        messages?: Array<{ role: 'user' | 'assistant'; content: string; createdAt?: number }>;
        state?: Record<string, unknown>;
      } = {},
    ) => {
      link.emit(
        { type: 'chat.spawned', chatId, hostId, folder: `/w/${chatId}` } as WireEvent,
        hostId,
      );
      link.emit(
        {
          type: 'chat.state',
          chatId,
          hostId,
          name: opts.name ?? null,
          status: 'active',
          pinned: false,
          folder: `/w/${chatId}`,
          permissionMode: 'default',
          lastUpdated: opts.lastUpdated ?? 100,
          ...opts.state,
        } as WireEvent,
        hostId,
      );
      (opts.messages ?? []).forEach((m, seq) =>
        link.emit({ type: 'chat.message', chatId, seq, ...m } as WireEvent, hostId),
      );
    };
    return { built, link, registry, get, body, chat };
  }

  it('refuses an unauthenticated caller', async () => {
    const { built } = await boot();
    try {
      const res = await built.app.inject({ method: 'GET', url: '/api/chats/search?q=boiler' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('refuses a query under two characters, out-of-range paging and nonsense flags', async () => {
    const { built, get } = await boot();
    try {
      expect((await get('q=b')).statusCode).toBe(400);
      expect((await get('q=boiler&limit=0')).statusCode).toBe(400);
      expect((await get('q=boiler&offset=-1')).statusCode).toBe(400);
      for (const flag of ['fullText', 'includeArchived', 'includeHidden']) {
        expect((await get(`q=boiler&${flag}=maybe`)).statusCode).toBe(400);
      }
    } finally {
      await built.app.close();
    }
  });

  it('searches every chat from the record, an offline host’s included, never asking a host', async () => {
    const { built, link, body, chat } = await boot();
    try {
      chat('pi-chat', 'pi', {
        lastUpdated: 300,
        messages: [
          { role: 'user', content: 'rotate the boiler keys', createdAt: 1_700_000_000_000 },
          { role: 'assistant', content: 'done' },
        ],
      });
      chat('mac-chat', 'mac', {
        lastUpdated: 200,
        messages: [{ role: 'assistant', content: 'the boiler from the mac' }],
      });
      chat('d1-chat', 'd1', { name: 'Boiler service', lastUpdated: 100 });
      chat('quiet', 'd1', { messages: [{ role: 'user', content: 'kettle' }] });
      const sentBefore = link.sent.length;
      const res = await body('q=boiler');
      expect(res.hits.map((h) => h.chatId)).toEqual(['pi-chat', 'mac-chat', 'd1-chat']);
      expect(res.total).toBe(3);
      expect(res.hits[0]!.snippet).toMatchObject({
        role: 'user',
        seq: 0,
        createdAt: 1_700_000_000_000,
      });
      expect(res.hits[2]).toMatchObject({ nameMatch: true, messageMatches: 0, snippet: null });
      expect('mirrored' in res.hits[0]!).toBe(false);
      // Every host is named, as searched, with its count of chats.
      expect(res.hosts).toEqual([
        { hostId: 'd1', hostName: null, state: 'searched', searchedChats: 2 },
        { hostId: 'mac', hostName: 'MacBook', state: 'searched', searchedChats: 1 },
        { hostId: 'pi', hostName: null, state: 'searched', searchedChats: 1 },
      ]);
      expect(link.sent.slice(sentBefore).filter((s) => s.event.type.includes('search'))).toEqual(
        [],
      );
    } finally {
      await built.app.close();
    }
  });

  it('fullText=false matches names and ids only', async () => {
    const { built, body, chat } = await boot();
    try {
      chat('pi-chat', 'pi', { messages: [{ role: 'user', content: 'boiler' }] });
      chat('named', 'd1', { name: 'boiler notes' });
      expect((await body('q=boiler&fullText=false')).hits.map((h) => h.chatId)).toEqual(['named']);
      // A pasted chat id finds the chat, with or without full text.
      for (const q of ['q=pi-chat', 'q=PI-CHAT&fullText=false']) {
        expect((await body(q)).hits.map((h) => h.chatId)).toEqual(['pi-chat']);
      }
    } finally {
      await built.app.close();
    }
  });

  it('falls back to the stored preview where the record holds no match', async () => {
    const { built, body, chat } = await boot();
    try {
      chat('old', 'pi', { state: { preview: 'the boiler from long ago' } });
      const res = await body('q=boiler');
      expect(res.hits.map((h) => h.chatId)).toEqual(['old']);
      expect(res.hits[0]!.snippet).toMatchObject({ role: 'user', seq: null, createdAt: null });
      expect(res.hits[0]!.messageMatches).toBe(1);
    } finally {
      await built.app.close();
    }
  });

  it('leaves archived and hidden chats out unless asked for', async () => {
    const { built, body, chat } = await boot();
    try {
      chat('arch', 'd1', { name: 'boiler a', state: { status: 'archived' } });
      chat('hid', 'd1', { name: 'boiler h', state: { hidden: true } });
      expect((await body('q=boiler')).hits).toEqual([]);
      expect((await body('q=boiler&includeArchived=true')).hits.map((h) => h.chatId)).toEqual([
        'arch',
      ]);
      expect((await body('q=boiler&includeHidden=1')).hits.map((h) => h.chatId)).toEqual(['hid']);
    } finally {
      await built.app.close();
    }
  });

  it('pages the ranked list', async () => {
    const { built, body, chat } = await boot();
    try {
      for (let i = 0; i < 5; i++)
        chat(`c${i}`, 'd1', { name: `boiler ${i}`, lastUpdated: 100 + i });
      const first = await body('q=boiler&limit=2');
      expect(first.hits.map((h) => h.chatId)).toEqual(['c4', 'c3']);
      expect(first.nextOffset).toBe(2);
      const last = await body('q=boiler&limit=2&offset=4');
      expect(last.hits.map((h) => h.chatId)).toEqual(['c0']);
      expect(last.nextOffset).toBeNull();
      expect(last.total).toBe(5);
    } finally {
      await built.app.close();
    }
  });

  it("tags a job-spawned chat with its job from the server's registry", async () => {
    const { built, body, chat } = await boot();
    try {
      chat('jobbed', 'd1', { name: 'boiler job' });
      const row = built.chatRegistry.get('jobbed')!;
      (row as { jobId: string | null }).jobId = 'job-1';
      expect((await body('q=boiler')).hits[0]!.jobId).toBe('job-1');
    } finally {
      await built.app.close();
    }
  });

  it('answers from the record kept before this start, and clears the old mirror', async () => {
    new ChatLogStore({ dataDir: dir, logger: { warn: () => undefined } }).commit({
      type: 'chat.message',
      chatId: 'pi-old',
      seq: 3,
      role: 'assistant',
      content: 'the boiler was serviced in March',
    } as WireEvent);
    mkdirSync(join(dir, 'chat-mirror'));
    writeFileSync(join(dir, 'chat-mirror', 'pi-old.jsonl'), '{"seq":3}\n');
    const { built, body, link } = await boot();
    try {
      expect(existsSync(join(dir, 'chat-mirror'))).toBe(false);
      link.emit(
        { type: 'chat.spawned', chatId: 'pi-old', hostId: 'pi', folder: '/srv' } as WireEvent,
        'pi',
      );
      const res = await body('q=serviced');
      expect(res.hits.map((h) => [h.chatId, h.snippet?.seq])).toEqual([['pi-old', 3]]);
    } finally {
      await built.app.close();
    }
  });
});
