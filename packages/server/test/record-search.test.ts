// Searching the server's record of each chat (spec/03 § Chat search): what
// answers for a chat whose host is offline.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSearchQuery, type WireEvent } from '@patch/wire';
import { ChatLogStore } from '../src/chat-log-store.js';
import { removeRetiredChatMirror } from '../src/retired-chat-mirror.js';

const msg = (chatId: string, seq: number, role: 'user' | 'assistant' | 'system', content: string) =>
  ({ type: 'chat.message', chatId, seq, role, content }) as WireEvent;

const terms = (q: string) => parseSearchQuery(q);

describe('ChatLogStore.searchMessages', () => {
  let dir: string;
  const logger = { warn: vi.fn() };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-record-search-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds user and assistant text, newest match as the snippet, across a restart', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.commit(msg('c1', 0, 'user', 'fix the boiler'));
    store.commit(msg('c1', 1, 'assistant', 'the boiler pressure is low'));
    store.commit(msg('c1', 2, 'system', 'boiler system line'));
    const fresh = new ChatLogStore({ dataDir: dir, logger });
    const found = fresh.searchMessages('c1', terms('boiler'));
    expect(found?.messageMatches).toBe(2);
    expect(found?.snippet).toMatchObject({ role: 'assistant', seq: 1, createdAt: null });
    expect(found?.snippet.highlights.length).toBeGreaterThan(0);
    expect(fresh.searchMessages('c1', terms('kettle'))).toBeNull();
    expect(fresh.searchMessages('nope', terms('boiler'))).toBeNull();
  });

  it('needs every term, and a phrase matches across a line break', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.commit(msg('c1', 0, 'user', 'rotate the\nboiler keys'));
    store.commit(msg('c1', 1, 'user', 'boiler only'));
    expect(store.searchMessages('c1', terms('"the boiler" keys'))?.messageMatches).toBe(1);
    expect(store.searchMessages('c1', terms('BOILER'))?.messageMatches).toBe(2);
  });

  it('ignores tool calls and results that mention the term', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.commit({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 0,
      callId: 'k',
      tool: 'Bash',
      input: { command: 'echo chat.message boiler' },
    } as unknown as WireEvent);
    expect(store.searchMessages('c1', terms('boiler'))).toBeNull();
  });

  it('sees messages committed after an earlier search, and an update replaces the text', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.commit(msg('c1', 0, 'user', 'first'));
    expect(store.searchMessages('c1', terms('second'))).toBeNull();
    store.commit(msg('c1', 1, 'assistant', 'second answer'));
    expect(store.searchMessages('c1', terms('second'))?.snippet.seq).toBe(1);
    store.commit(msg('c1', 1, 'assistant', 'rewritten answer'));
    expect(store.searchMessages('c1', terms('second'))).toBeNull();
    expect(store.searchMessages('c1', terms('rewritten'))?.messageMatches).toBe(1);
  });

  it('takes a torn last line only once its newline lands, and skips a corrupt one', () => {
    const logs = join(dir, 'chat-logs');
    mkdirSync(logs, { recursive: true });
    const path = join(logs, 'c1.jsonl');
    const whole = JSON.stringify(msg('c1', 0, 'user', 'boiler one'));
    const torn = JSON.stringify(msg('c1', 1, 'user', 'boiler two'));
    writeFileSync(path, `${whole}\n{"type":"chat.message" broken\n${torn.slice(0, 20)}`);
    const store = new ChatLogStore({ dataDir: dir, logger });
    expect(store.searchMessages('c1', terms('boiler'))?.messageMatches).toBe(1);
    appendFileSync(path, `${torn.slice(20)}\n`);
    expect(store.searchMessages('c1', terms('boiler'))?.messageMatches).toBe(2);
  });

  it('starts again when the file is replaced by a shorter one', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.commit(msg('c1', 0, 'user', 'boiler with a long message body'));
    expect(store.searchMessages('c1', terms('boiler'))).not.toBeNull();
    writeFileSync(
      join(dir, 'chat-logs', 'c1.jsonl'),
      `${JSON.stringify(msg('c1', 0, 'user', 'kettle'))}\n`,
    );
    expect(store.searchMessages('c1', terms('boiler'))).toBeNull();
    expect(store.searchMessages('c1', terms('kettle'))).not.toBeNull();
  });

  it('searches a store kept in memory only', () => {
    const store = new ChatLogStore({ logger });
    store.commit(msg('c1', 0, 'user', 'boiler'));
    expect(store.searchMessages('c1', terms('boiler'))?.messageMatches).toBe(1);
    expect(store.holds('c1')).toBe(true);
    expect(store.holds('c2')).toBe(false);
  });

  it('says whether it holds a chat without loading it', () => {
    new ChatLogStore({ dataDir: dir, logger }).commit(msg('c1', 0, 'user', 'hi'));
    const fresh = new ChatLogStore({ dataDir: dir, logger });
    expect(fresh.holds('c1')).toBe(true);
    expect(fresh.holds('c2')).toBe(false);
    expect((fresh as unknown as { chats: Map<string, unknown> }).chats.size).toBe(0);
  });

  it('searches a chat of many messages quickly, and a repeat costs almost nothing', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    for (let i = 0; i < 20_000; i++) {
      store.commit(msg('big', i, i % 2 ? 'assistant' : 'user', `message ${i} about things`));
    }
    store.commit(msg('big', 20_000, 'user', 'the needle'));
    const fresh = new ChatLogStore({ dataDir: dir, logger });
    const t0 = performance.now();
    expect(fresh.searchMessages('big', terms('needle'))?.snippet.seq).toBe(20_000);
    const first = performance.now() - t0;
    const t1 = performance.now();
    fresh.searchMessages('big', terms('needle'));
    const repeat = performance.now() - t1;
    expect(first).toBeLessThan(2_000);
    expect(repeat).toBeLessThan(first);
  });
});

describe('removeRetiredChatMirror', () => {
  let dir: string;
  const logger = { info: vi.fn(), warn: vi.fn() };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-retired-mirror-'));
    logger.info.mockClear();
    logger.warn.mockClear();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('removes the old mirror folder once and leaves the record alone', () => {
    mkdirSync(join(dir, 'chat-mirror'));
    writeFileSync(join(dir, 'chat-mirror', 'c1.jsonl'), '{"seq":0}\n');
    new ChatLogStore({ dataDir: dir, logger }).commit(msg('c1', 0, 'user', 'kept'));
    expect(removeRetiredChatMirror(dir, logger)).toBe(true);
    expect(existsSync(join(dir, 'chat-mirror'))).toBe(false);
    expect(existsSync(join(dir, 'chat-logs', 'c1.jsonl'))).toBe(true);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(removeRetiredChatMirror(dir, logger)).toBe(false);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});
