// spec/02 § Chat loading: at start the host loads only the chats with live or
// owed work; every other chat is opened when something names it.
//
// Before this, a host with thousands of chats opened every one of them (meta,
// log head and tail, seq files) before it could do anything, ~15 s of I/O on
// the production box.

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore, type MetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const idle: SdkBackend = {
  run: async function* () {
    yield { type: 'result', sessionId: 'sess-1' };
  },
};

const NOW = 1_700_000_000_000;

function counting(store: MetaStore) {
  const reads: string[] = [];
  let lists = 0;
  const wrapped: MetaStore = {
    ...store,
    read: (id) => {
      reads.push(id);
      return store.read(id);
    },
    list: () => {
      lists += 1;
      return store.list();
    },
  };
  return { wrapped, reads, lists: () => lists };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-lazy-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-lazy-folder-')));
  mkdirSync(folder, { recursive: true });
  let n = 0;
  const host = (metaStore: MetaStore = createMetaStore(home)) =>
    new Daemon({
      hostId: 'd1',
      metaStore,
      sdkBackend: idle,
      oauthAccessToken: 'tok',
      emit: () => {},
      logger: pino({ level: 'silent' }),
      now: () => NOW,
      generateChatId: () => `chat-${++n}`,
    });
  return { home, folder, host };
}

describe('start-up loads only chats with live or owed work', () => {
  it('leaves an idle chat on disk and opens it when named', async () => {
    const { home, folder, host } = setup();
    const first = host();
    const idleChat = await first.spawnChat({ folder });
    first.shutdown();

    const second = host();
    second.hydrate();
    expect(second.chatState.loaded(idleChat)).toBeUndefined();
    expect(second.list().map((c) => c.chatId)).not.toContain(idleChat);
    // Reading it is what opens it.
    expect(second.chatState.get(idleChat)?.chatId).toBe(idleChat);
    expect(second.chatState.loaded(idleChat)).toBeDefined();
    expect(existsSync(join(home, 'live-chats.json'))).toBe(true);
    second.shutdown();
  });

  it('loads chats with a snooze, a pending wake or an owed turn', async () => {
    const { home, folder, host } = setup();
    const metaStore = createMetaStore(home);
    const first = host(metaStore);
    const idleChat = await first.spawnChat({ folder });
    const snoozed = await first.spawnChat({ folder });
    const woken = await first.spawnChat({ folder });
    const owed = await first.spawnChat({ folder });
    metaStore.update(snoozed, (m) => ({ ...m, snoozedUntil: NOW + 3_600_000 }));
    first.scheduleWake(woken, { in: '2h', message: 'later' });
    metaStore.update(owed, (m) => ({ ...m, pendingTurns: [{ message: 'carry on' }] }));
    first.shutdown();

    const second = host(metaStore);
    second.hydrate();
    for (const id of [snoozed, woken, owed]) {
      expect(second.chatState.loaded(id), id).toBeDefined();
    }
    expect(second.chatState.loaded(idleChat)).toBeUndefined();
    second.shutdown();
  });

  it('reads only the listed chats on a later start, not every chat', async () => {
    const { home, folder, host } = setup();
    const store = createMetaStore(home);
    const first = host(store);
    const idleChats: string[] = [];
    for (let i = 0; i < 5; i++) idleChats.push(await first.spawnChat({ folder }));
    const owed = await first.spawnChat({ folder });
    store.update(owed, (m) => ({ ...m, pendingTurns: [{ message: 'carry on' }] }));
    first.shutdown();

    // First start since the list existed: one scan builds it.
    const scan = counting(store);
    const second = host(scan.wrapped);
    second.hydrate();
    expect(scan.lists()).toBe(1);
    second.shutdown();
    expect(JSON.parse(readFileSync(join(home, 'live-chats.json'), 'utf8')).chats).toContain(owed);

    // Every later start reads the chats on the list and nothing else.
    const later = counting(store);
    const third = host(later.wrapped);
    third.hydrate();
    expect(later.lists()).toBe(0);
    expect(new Set(later.reads)).toEqual(new Set([owed]));
    for (const id of idleChats) expect(third.chatState.loaded(id)).toBeUndefined();
    third.shutdown();
  });

  it('adds a chat to the list the moment it gains work, and drops it once it has none', async () => {
    const { home, folder, host } = setup();
    const store = createMetaStore(home);
    const daemon = host(store);
    const chat = await daemon.spawnChat({ folder });
    daemon.hydrate(); // establishes the (empty) list
    const listed = () => JSON.parse(readFileSync(join(home, 'live-chats.json'), 'utf8')).chats;
    expect(listed()).toEqual([]);

    store.update(chat, (m) => ({ ...m, pendingTurns: [{ message: 'x' }] }));
    expect(listed()).toEqual([chat]);

    store.update(chat, (m) => ({ ...m, pendingTurns: [] }));
    daemon.trimLiveChats();
    expect(listed()).toEqual([]);

    daemon.scheduleWake(chat, { in: '1h', message: 'later' });
    expect(listed()).toEqual([chat]);
    daemon.shutdown();
  });

  it('a chat that gained work after the list was written is still found on restart', async () => {
    const { home, folder, host } = setup();
    const store = createMetaStore(home);
    const first = host(store);
    const chat = await first.spawnChat({ folder });
    first.hydrate();
    store.update(chat, (m) => ({ ...m, pendingTurns: [{ message: 'owed' }] }));
    // No shutdown: the host died right here.
    const second = host(store);
    second.hydrate();
    expect(second.chatState.loaded(chat)).toBeDefined();
    second.shutdown();
    first.shutdown();
  });
});

describe('chats that are not loaded still behave as chats', () => {
  it('listAll covers every chat, loaded or not, without loading them', async () => {
    const { folder, host } = setup();
    const first = host();
    const a = await first.spawnChat({ folder });
    const b = await first.spawnChat({ folder });
    first.shutdown();
    const second = host();
    second.hydrate();
    expect(
      second
        .listAll()
        .map((c) => c.chatId)
        .sort(),
    ).toEqual([a, b].sort());
    expect(second.chatState.loaded(a)).toBeUndefined();
    second.shutdown();
  });

  it('resolves an id prefix against every chat on disk', async () => {
    const { folder, host } = setup();
    const first = host();
    const a = await first.spawnChat({ folder });
    await first.spawnChat({ folder });
    first.shutdown();
    const second = host();
    second.hydrate();
    expect(second.chatState.resolve(a)?.chatId).toBe(a);
    // `chat-` prefixes both chats: ambiguous, even though neither is loaded.
    expect(second.chatState.resolve('chat-')).toBeUndefined();
    second.shutdown();
  });

  it('a chat deleted from disk is not found', async () => {
    const { home, folder, host } = setup();
    const first = host();
    const a = await first.spawnChat({ folder });
    first.shutdown();
    rmSync(join(home, 'chats', a), { recursive: true, force: true });
    const second = host();
    second.hydrate();
    expect(second.chatState.get(a)).toBeUndefined();
    second.shutdown();
  });

  it('every chat id is listed from the directory alone', async () => {
    const { home, folder, host } = setup();
    const first = host();
    const a = await first.spawnChat({ folder });
    first.shutdown();
    const store = counting(createMetaStore(home));
    const second = host(store.wrapped);
    expect(second.allChatIds()).toEqual([a]);
    expect(store.reads).toEqual([]);
    second.shutdown();
  });
});
