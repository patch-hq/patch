// The one-off send of what the server's record lacks (spec/01 § Chat record).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import { RecordImport, importable } from '../src/recordImport.js';

const silent = pino({ level: 'silent' });

const artifact = (chatId: string, seq: number): WireEvent =>
  ({
    type: 'chat.artifact',
    chatId,
    artifactId: `a${seq}`,
    title: 't',
    url: '/a',
    path: 'p',
    updatedAt: 1,
    seq,
  }) as WireEvent;

describe('importable', () => {
  it('keeps artifacts, final summaries and answered questions, nothing else', () => {
    const events = [
      { type: 'chat.spawned', chatId: 'c1', hostId: 'h', folder: '/' },
      { type: 'chat.message', chatId: 'c1', role: 'user', content: 'x', seq: 0 },
      artifact('c1', 1),
      { type: 'chat.tool_run_summary', chatId: 'c1', callIds: ['t'], summary: 'ran', seq: 2 },
      {
        type: 'chat.tool_run_summary',
        chatId: 'c1',
        callIds: ['u'],
        summary: 'running',
        live: true,
        seq: 3,
      },
      {
        type: 'chat.permission_request',
        chatId: 'c1',
        requestId: 'q1',
        request: { tool: 'AskUserQuestion', args: {} },
        seq: 4,
        forSurfaceId: 's1',
      },
      { type: 'chat.permission_response', chatId: 'c1', requestId: 'q1', approve: false },
      {
        type: 'chat.permission_request',
        chatId: 'c1',
        requestId: 'p1',
        request: { tool: 'Bash', args: {} },
        seq: 5,
      },
      { type: 'chat.permission_response', chatId: 'c1', requestId: 'p1', approve: true },
    ] as WireEvent[];
    const kept = importable(events);
    expect(kept.map((e) => e.type)).toEqual([
      'chat.artifact',
      'chat.tool_run_summary',
      'chat.permission_request',
      'chat.permission_response',
    ]);
    // The routing tag of the replay it was gathered from is not part of it.
    expect(kept[2]).not.toHaveProperty('forSurfaceId');
  });
});

describe('RecordImport', () => {
  let dir: string;
  let sent: WireEvent[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-record-import-'));
    sent = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const make = (chats: Record<string, WireEvent[]>) =>
    new RecordImport({
      path: join(dir, 'record-import.json'),
      logger: silent,
      listChats: () => Object.keys(chats),
      replayChat: (chatId, emit) => {
        if (chatId === 'broken') throw new Error('unreadable');
        for (const e of chats[chatId] ?? []) emit(e);
      },
      send: (e) => sent.push(e),
      defer: (fn) => fn(),
    });

  it('sends one chat at a time, each after the last is acknowledged, skipping chats with nothing to send', () => {
    const imp = make({ c1: [artifact('c1', 1)], empty: [], broken: [], c2: [artifact('c2', 1)] });
    imp.start();
    expect(sent.map((e) => (e as { chatId: string }).chatId)).toEqual(['c1']);
    imp.onAck('c1');
    expect(sent.map((e) => (e as { chatId: string }).chatId)).toEqual(['c1', 'c2']);
    expect(imp.isComplete()).toBe(false);
    imp.onAck('c2');
    expect(imp.isComplete()).toBe(true);
  });

  it('carries on where it stopped after a dropped link, and never runs again once complete', () => {
    const chats = { c1: [artifact('c1', 1)], c2: [artifact('c2', 1)] };
    const first = make(chats);
    first.start();
    first.onAck('c1');
    first.stop(); // the link dropped while c2 was in flight
    sent.length = 0;
    const second = make(chats);
    second.start();
    expect(sent.map((e) => (e as { chatId: string }).chatId)).toEqual(['c2']);
    second.onAck('c2');
    sent.length = 0;
    const third = make(chats);
    third.start();
    expect(sent).toEqual([]);
  });

  it('ignores an acknowledgement for a chat it is not waiting on', () => {
    const imp = make({ c1: [artifact('c1', 1)], c2: [artifact('c2', 1)] });
    imp.start();
    imp.onAck('c2');
    expect(sent).toHaveLength(1);
  });
});
