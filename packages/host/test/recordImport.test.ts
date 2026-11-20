// The one-time import of every chat into the server's record (spec/01 § Chat record).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECORD_FRAME_BYTES, type WireEvent } from '@patch/wire';
import { RecordImport, RECORD_IMPORT_VERSION, framesOf } from '../src/recordImport.js';

const silent = pino({ level: 'silent' });

const say = (chatId: string, seq: number, content = `m${seq}`): WireEvent =>
  ({ type: 'chat.message', chatId, role: 'assistant', content, seq }) as WireEvent;

const chatsOf = (sent: WireEvent[]) => sent.map((e) => (e as { chatId: string }).chatId);

describe('framesOf', () => {
  it('splits a chat into frames under the replay batch size, without routing tags', () => {
    const big = 'x'.repeat(Math.floor(RECORD_FRAME_BYTES / 2));
    const frames = framesOf([
      { ...say('c1', 0, big), forSurfaceId: 's1' } as WireEvent,
      say('c1', 1, big),
      say('c1', 2),
    ]);
    expect(frames.map((f) => f.map((e) => (e as { seq: number }).seq))).toEqual([[0], [1, 2]]);
    expect(frames[0]![0]).not.toHaveProperty('forSurfaceId');
  });

  it('never makes a frame of more than 200 events', () => {
    const frames = framesOf(Array.from({ length: 450 }, (_, i) => say('c1', i)));
    expect(frames.map((f) => f.length)).toEqual([200, 200, 50]);
  });
});

describe('RecordImport', () => {
  let dir: string;
  let sent: WireEvent[];
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-record-import-'));
    path = join(dir, 'record-import.json');
    sent = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const make = (chats: Record<string, WireEvent[] | null | 'unreadable'>) =>
    new RecordImport({
      path,
      logger: silent,
      listChats: () => Object.keys(chats),
      recordOf: (chatId) => {
        const held = chats[chatId];
        if (held === 'unreadable') throw new Error('unreadable');
        return held ?? null;
      },
      send: (e) => sent.push(e),
      defer: (fn) => fn(),
    });

  const progress = () =>
    JSON.parse(readFileSync(path, 'utf8')) as {
      version: number;
      complete: boolean;
      done: string[];
    };

  it("sends every chat's whole record, one chat at a time, each after the last is acknowledged", () => {
    const record = [
      { type: 'chat.turn_started', chatId: 'c1', turnId: 't', seq: -1, at: 1 },
      { ...say('c1', 0), nativeRef: { harness: 'claude', sessionId: 's', id: 'u' } },
      { type: 'chat.turn_ended', chatId: 'c1', turnId: 't', seq: 0, at: 2, outcome: 'completed' },
    ] as WireEvent[];
    const imp = make({ c1: record, empty: [], gone: null, c2: [say('c2', 0)] });
    imp.start();
    expect(sent).toEqual([
      { type: 'host.record_import', chatId: 'c1', events: record, done: true },
    ]);
    imp.onAck('c1');
    expect(chatsOf(sent)).toEqual(['c1', 'c2']);
    expect(imp.isComplete()).toBe(false);
    imp.onAck('c2');
    expect(imp.isComplete()).toBe(true);
    expect(progress()).toEqual({
      version: RECORD_IMPORT_VERSION,
      complete: true,
      done: ['c1', 'empty', 'gone', 'c2'],
    });
  });

  it('names each subagent’s parent, so the server keeps its record against it', () => {
    const imp = new RecordImport({
      path,
      logger: silent,
      listChats: () => ['sub-1'],
      recordOf: () => [say('sub-1', 0)],
      parentOf: (chatId) => (chatId === 'sub-1' ? 'parent-1' : undefined),
      send: (e) => sent.push(e),
      defer: (fn) => fn(),
    });
    imp.start();
    expect(sent).toEqual([
      {
        type: 'host.record_import',
        chatId: 'sub-1',
        parentChatId: 'parent-1',
        events: [say('sub-1', 0)],
        done: true,
      },
    ]);
  });

  it('sends a long chat as several frames, and only the last says it is done', () => {
    const imp = make({ c1: Array.from({ length: 250 }, (_, i) => say('c1', i)) });
    imp.start();
    expect(sent.map((e) => (e as { done: boolean }).done)).toEqual([false, true]);
  });

  it('carries on where it stopped after a dropped link, and never runs again once complete', () => {
    const chats = { c1: [say('c1', 0)], c2: [say('c2', 0)] };
    const first = make(chats);
    first.start();
    first.onAck('c1');
    first.stop(); // the link dropped while c2 was in flight
    sent.length = 0;
    const second = make(chats);
    second.start();
    expect(chatsOf(sent)).toEqual(['c2']);
    second.onAck('c2');
    sent.length = 0;
    const third = make(chats);
    third.start();
    expect(sent).toEqual([]);
  });

  it('gives up on a connection whose acknowledgement never comes, and resumes on the next', async () => {
    const imp = new RecordImport({
      path,
      logger: silent,
      listChats: () => ['c1'],
      recordOf: (chatId) => [say(chatId, 0)],
      send: (e) => sent.push(e),
      defer: (fn) => fn(),
      ackTimeoutMs: 5,
    });
    imp.start();
    await new Promise((r) => setTimeout(r, 20));
    imp.start();
    expect(chatsOf(sent)).toEqual(['c1', 'c1']);
  });

  it('a chat it cannot read does not hold up the rest, and leaves the import to finish next time', () => {
    const chats: Record<string, WireEvent[] | 'unreadable'> = {
      bad: 'unreadable',
      c1: [say('c1', 0)],
    };
    const imp = make(chats);
    imp.start();
    imp.onAck('c1');
    expect(imp.isComplete()).toBe(false);
    expect(progress()).toMatchObject({ complete: false, done: ['c1'] });
    sent.length = 0;
    chats['bad'] = [say('bad', 0)];
    const again = make(chats);
    again.start();
    expect(chatsOf(sent)).toEqual(['bad']);
    again.onAck('bad');
    expect(again.isComplete()).toBe(true);
  });

  it('runs once more over every chat on a host whose earlier, partial import completed, then stops', () => {
    // What the earlier import left behind: no version, every chat done.
    writeFileSync(path, JSON.stringify({ complete: true, done: ['c1', 'c2'] }));
    const chats = { c1: [say('c1', 0)], c2: [say('c2', 0)] };
    const topUp = make(chats);
    expect(topUp.isComplete()).toBe(false);
    topUp.start();
    topUp.onAck('c1');
    topUp.onAck('c2');
    expect(chatsOf(sent)).toEqual(['c1', 'c2']);
    expect(topUp.isComplete()).toBe(true);
    sent.length = 0;
    const after = make(chats);
    after.start();
    expect(sent).toEqual([]);
  });

  it('ignores an acknowledgement for a chat it is not waiting on', () => {
    const imp = make({ c1: [say('c1', 0)], c2: [say('c2', 0)] });
    imp.start();
    imp.onAck('c2');
    expect(sent).toHaveLength(1);
  });
});
