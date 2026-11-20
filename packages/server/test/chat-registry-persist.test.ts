// The server owns what it last knew about each chat (spec/01 § Chat state): the
// mirror is saved as it changes and read back at startup, so a restart begins
// from that rather than from nothing.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { ChatRegistry } from '../src/chat-registry.js';
import { turnEnded, turnStarted } from './support/turn-facts.js';

const logger = pino({ level: 'silent' });

const spawned = (chatId: string, hostId = 'd1'): WireEvent =>
  ({ type: 'chat.spawned', chatId, hostId, folder: `/w/${chatId}` }) as WireEvent;

const state = (chatId: string, activity: string, over: Record<string, unknown> = {}): WireEvent =>
  ({
    type: 'chat.state',
    chatId,
    hostId: 'd1',
    activity,
    permissionMode: 'auto',
    folder: `/w/${chatId}`,
    lastUpdated: 100,
    ...over,
  }) as WireEvent;

const foldersList = (hostId: string): WireEvent =>
  ({ type: 'folders.list', hostId, roots: [], recent: [] }) as WireEvent;

describe('ChatRegistry persistence', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-reg-'));
    path = join(dir, 'chat-registry.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const make = (jobId: string | null = null): ChatRegistry =>
    new ChatRegistry({ logger, persistPath: path, jobChatLinks: { get: () => jobId } });

  test('starts from what it knew: activity, status, host, job and time survive a restart', () => {
    const first = make('j_1');
    first.observe(spawned('c1'));
    first.observe(state('c1', 'idle', { lastUpdated: 777, status: 'active' }));
    first.flush();

    const second = make();
    expect(second.get('c1')).toMatchObject({
      chatId: 'c1',
      activity: 'idle',
      status: 'active',
      hostId: 'd1',
      jobId: 'j_1',
      lastUpdated: 777,
    });
  });

  test('a restored chat takes chat.state without being announced again', () => {
    const first = make();
    first.observe(spawned('c1'));
    first.observe(state('c1', 'running'));
    first.flush();

    const second = make();
    second.observe(state('c1', 'idle', { lastUpdated: 900 }));
    expect(second.get('c1')).toMatchObject({ activity: 'idle', lastUpdated: 900 });
  });

  test('a chat the server never knew is still refused a row from a bare chat.state', () => {
    const r = make();
    r.observe(state('ghost', 'idle'));
    expect(r.get('ghost')).toBeUndefined();
  });

  test('is written a moment after a change, without being asked', async () => {
    const r = make();
    r.observe(spawned('c1'));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(JSON.parse(readFileSync(path, 'utf8').split('\n')[0]!).c.chatId).toBe('c1');
  });

  test('keeps an error, a removal, a delete and a move', () => {
    const first = make();
    for (const id of ['c1', 'c2', 'c3', 'c4']) {
      first.observe(spawned(id));
      first.observe(turnStarted(id));
    }
    first.observe(turnEnded('c1', 'failed', { code: 'internal', message: 'x' }));
    first.remove('c2');
    first.setDeleted('c3', true);
    first.rehome('c4', 'd2', '/elsewhere');
    first.flush();

    const second = make();
    expect(second.get('c1')?.activity).toBe('errored');
    expect(second.get('c1')?.chatStatus).toMatchObject({ state: 'failed', reason: 'internal' });
    expect(second.get('c2')).toBeUndefined();
    expect(second.get('c3')?.status).toBe('deleted');
    expect(second.get('c4')).toMatchObject({ hostId: 'd2', folder: '/elsewhere' });
  });

  test('the server’s record decides a chat exists: a host that no longer lists it does not remove it', () => {
    const first = make();
    first.observe(spawned('kept'));
    first.observe(spawned('folder-missing'));
    first.flush();

    const second = make();
    second.observe(spawned('kept'));
    second.observe({ ...foldersList('d1'), chatIds: ['kept'] } as WireEvent);
    second.observe(foldersList('d1'));
    expect(second.get('kept')).toBeDefined();
    expect(second.get('folder-missing')).toMatchObject({ hostId: 'd1' });
    second.flush();
    expect(make().get('folder-missing')).toBeDefined();
  });

  test('starts empty, saying so, when the saved index is damaged before its last line', () => {
    writeFileSync(path, '{not json\n{"x":"c1"}\n');
    const warnings: string[] = [];
    const r = new ChatRegistry({
      logger: { warn: (_o: unknown, msg?: string) => warnings.push(String(msg)) },
      persistPath: path,
    });
    expect(r.size()).toBe(0);
    expect(warnings.join(' ')).toContain('could not read the saved chat index');
  });

  test('without a path it stays in memory only', () => {
    const r = new ChatRegistry({ logger });
    r.observe(spawned('c1'));
    r.flush();
    expect(r.size()).toBe(1);
  });

  describe('knowing a chat has worked', () => {
    const at = (nowMs: number): ChatRegistry =>
      new ChatRegistry({ logger, persistPath: path, now: () => nowMs });

    test('a chat seen working has worked since before it, and not since after', () => {
      const r = at(5_000);
      r.observe(spawned('c1'));
      expect(r.hasWorkedSince('c1', 0)).toBe(false); // announced, not yet seen working
      r.observe(turnStarted('c1'));
      expect(r.hasWorkedSince('c1', 4_000)).toBe(true);
      expect(r.hasWorkedSince('c1', 6_000)).toBe(false);
    });

    test('is remembered across a restart', () => {
      const first = at(5_000);
      first.observe(spawned('c1'));
      first.observe(turnStarted('c1'));
      first.flush();
      expect(at(9_000).hasWorkedSince('c1', 4_000)).toBe(true);
    });

    test('the facts behind a status survive a restart: a turn still open goes host offline when its host stays away', () => {
      const first = at(5_000);
      first.observe(spawned('c1'));
      first.observe(turnStarted('c1'));
      first.flush();
      const second = at(9_000);
      expect(second.get('c1')?.chatStatus?.state).toBe('running');
      expect(second.markHostAway('d1', 'offline').map((e) => e.chatStatus?.state)).toEqual([
        'host_offline',
      ]);
    });

    test('a chat its host reports idle with a first message and its own clock well past the start has worked', () => {
      const r = at(1);
      r.observe(spawned('c1'));
      r.observe(state('c1', 'idle', { preview: 'first message', lastUpdated: 100_000 }));
      expect(r.hasWorkedSince('c1', 50_000)).toBe(true);
      expect(r.hasWorkedSince('c1', 95_000)).toBe(false); // only just after: not enough
    });

    test('a chat with no first message accepted is not known to have worked', () => {
      const r = at(1);
      r.observe(spawned('c1'));
      r.observe(state('c1', 'idle', { lastUpdated: 100_000 }));
      expect(r.hasWorkedSince('c1', 0)).toBe(false);
    });

    test('an unknown chat has not', () => {
      expect(at(1).hasWorkedSince('nope', 0)).toBe(false);
    });
  });

  describe('reading an odd saved file', () => {
    // `body` is the old whole-file shape; write it as index lines.
    const read = (body: { chats?: unknown[]; worked?: Record<string, unknown> }): ChatRegistry => {
      const lines = [
        ...(body.chats ?? []).map((c) => JSON.stringify({ c })),
        ...Object.entries(body.worked ?? {}).map(([k, v]) => JSON.stringify({ w: [k, v] })),
      ];
      writeFileSync(path, lines.join('\n') + (lines.length ? '\n' : ''));
      return new ChatRegistry({ logger, persistPath: path });
    };

    test('a file with no chats and no record of work is an empty mirror', () => {
      const r = read({});
      expect(r.size()).toBe(0);
      expect(r.hasWorkedSince('c1', 0)).toBe(false);
    });

    test('skips an entry with no chat id, an empty one, or that is not an object', () => {
      const good = { chatId: 'c1', hostId: 'd1', activity: 'idle', status: 'active' };
      const r = read({ chats: [null, {}, { chatId: '' }, { chatId: 7 }, good] });
      expect(r.size()).toBe(1);
      expect(r.get('c1')).toBeDefined();
    });

    test('keeps a record of work only when it is a time', () => {
      const r = read({ chats: [], worked: { a: 5_000, b: 'yesterday', c: null } });
      expect(r.hasWorkedSince('a', 4_000)).toBe(true);
      expect(r.hasWorkedSince('b', 0)).toBe(false);
      expect(r.hasWorkedSince('c', 0)).toBe(false);
    });
  });
});
