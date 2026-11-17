// The chat index (spec/01 § Responsibilities): one line appended per changed
// chat, never the whole account rewritten on every change.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { ChatRegistry } from '../src/chat-registry.js';

const logger = pino({ level: 'silent' });
const spawned = (chatId: string): WireEvent =>
  ({ type: 'chat.spawned', chatId, hostId: 'd1', folder: `/w/${chatId}` }) as WireEvent;
const state = (chatId: string, activity: string, lastUpdated = 100): WireEvent =>
  ({
    type: 'chat.state',
    chatId,
    hostId: 'd1',
    activity,
    permissionMode: 'auto',
    folder: `/w/${chatId}`,
    lastUpdated,
  }) as WireEvent;

describe('chat index', () => {
  let dir: string;
  let path: string;
  let legacy: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-idx-'));
    path = join(dir, 'chat-index.jsonl');
    legacy = join(dir, 'chat-registry.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const make = (): ChatRegistry =>
    new ChatRegistry({ logger, persistPath: path, legacyPath: legacy });

  test('a change to one chat among many appends a line, it does not rewrite the rest', () => {
    const r = make();
    for (let i = 0; i < 200; i++) r.observe(spawned(`c${i}`));
    r.flush();
    const before = statSync(path).size;
    r.observe(state('c7', 'running', 500));
    r.flush();
    const grew = statSync(path).size - before;
    expect(grew).toBeGreaterThan(0);
    const lines = (): number => readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
    expect(lines()).toBeGreaterThan(200);
    expect(grew).toBeLessThan(before / 20);
  });

  test('restores the latest row per chat, removals and the worked time', () => {
    const a = make();
    a.observe(spawned('c1'));
    a.observe(spawned('c2'));
    a.observe(state('c1', 'running', 1));
    a.flush();
    a.observe(state('c1', 'idle', 2));
    a.remove('c2');
    a.flush();
    const b = make();
    expect(b.get('c1')).toMatchObject({ activity: 'idle', lastUpdated: 2 });
    expect(b.get('c2')).toBeUndefined();
  });

  test('keeps feedPos per row across a restart', () => {
    const a = make();
    a.observe(spawned('c1'));
    a.observe(state('c1', 'running'));
    a.flush();
    const pos = a.get('c1')?.feedPos;
    expect(pos).toBeGreaterThan(0);
    expect(make().get('c1')?.feedPos).toBe(pos);
  });

  test('a half-written last line from a crash is skipped, earlier rows survive', () => {
    const a = make();
    a.observe(spawned('c1'));
    a.flush();
    writeFileSync(path, readFileSync(path, 'utf8') + '{"c":{"chatId":"c9","na');
    expect(make().get('c1')).toBeDefined();
  });

  test('a branch change is saved', () => {
    const a = make();
    a.observe(spawned('c1'));
    a.observe({
      type: 'chat.branches',
      chatId: 'c1',
      branches: [],
      activeBranchId: 'b1',
    } as unknown as WireEvent);
    a.flush();
    expect(make().get('c1')?.activeBranchId).toBe('b1');
  });

  test('the old chat-registry.json is imported once and then retired', () => {
    const old = make();
    old.observe(spawned('c1'));
    const row = old.get('c1');
    writeFileSync(legacy, JSON.stringify({ version: 1, chats: [row], worked: { c1: 42 } }));
    rmSync(path, { force: true });
    const b = make();
    expect(b.get('c1')).toBeDefined();
    b.flush();
    expect(existsSync(legacy)).toBe(false);
    expect(make().get('c1')).toBeDefined();
  });

  test('a long history of changes is compacted so the file tracks live rows', () => {
    const a = make();
    a.observe(spawned('c1'));
    for (let i = 0; i < 3000; i++) {
      a.observe(state('c1', i % 2 ? 'running' : 'idle', i));
      a.flush();
    }
    const b = make();
    b.flush();
    expect(readFileSync(path, 'utf8').split('\n').filter(Boolean).length).toBeLessThan(50);
  });
});
