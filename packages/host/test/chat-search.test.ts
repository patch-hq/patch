// Chat search (spec/02 § Chat search): an in-memory index of each chat's own
// log, kept current incrementally, answering ranked hits with snippets and the
// matched message's seq.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import {
  ChatSearchIndex,
  handleChatSearchRequest,
  highlightRanges,
  makeSnippet,
  queryTerms,
  type SearchableChat,
} from '../src/chatSearch.js';

const NOW = 1_800_000_000_000;
const FOLDER = '/home/tom/project';

let root: string;
let chatsRoot: string;
let corrupt: { path: string; message: string }[];
let nextSeq: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'patch-chat-search-'));
  chatsRoot = join(root, 'chats');
  corrupt = [];
  nextSeq = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function index(): ChatSearchIndex {
  return new ChatSearchIndex(
    {
      logPath: (chatId) => join(chatsRoot, chatId, 'events.jsonl'),
      now: () => NOW,
      onCorruptLine: (info) => corrupt.push(info),
    },
    'host-a',
  );
}

function chat(over: Partial<SearchableChat> & { chatId: string }): SearchableChat {
  return {
    name: null,
    preview: null,
    folder: FOLDER,
    status: 'active',
    hidden: false,
    pinned: false,
    snoozedUntil: null,
    lastUpdated: NOW - 1000,
    claudeSessionId: `s-${over.chatId}`,
    ...over,
  };
}

/** One line of a chat's log, as `chatLog.ts` writes it. */
function record(event: Record<string, unknown>, seq = nextSeq++, branchId = 'b0'): string {
  return JSON.stringify({
    v: 1,
    seq,
    at: NOW,
    branchId,
    nativeRef: { harness: 'claude', sessionId: 's', id: `u-${seq}` },
    rec: { k: 'event', event: { chatId: 'c', seq, ...event } },
  });
}
const user = (text: string, ts = '2026-09-01T10:00:00.000Z'): string =>
  record({ type: 'chat.message', role: 'user', content: text, createdAt: Date.parse(ts) });
const assistant = (text: string, ts = '2026-09-01T10:00:05.000Z'): string =>
  record({ type: 'chat.message', role: 'assistant', content: text, createdAt: Date.parse(ts) });
const toolUse = (id: string, args: unknown): string =>
  record({ type: 'chat.tool_call', tool: 'Bash', args, callId: id });
const toolResult = (id: string, result: string): string =>
  record({ type: 'chat.tool_result', tool: 'Bash', result, callId: id });
const thinking = (text: string): string =>
  JSON.stringify({ v: 1, seq: -1, at: NOW, rec: { k: 'thinking', text } });

function logPath(c: SearchableChat): string {
  return join(chatsRoot, c.chatId, 'events.jsonl');
}
function writeLog(c: SearchableChat, lines: string[]): void {
  mkdirSync(join(chatsRoot, c.chatId), { recursive: true });
  writeFileSync(logPath(c), lines.map((l) => `${l}\n`).join(''));
}

describe('chat search index', () => {
  it('finds user and assistant text case-insensitively, every term in one message', () => {
    const c = chat({ chatId: 'c1', name: 'Heating' });
    writeLog(c, [
      user('Why is the Boiler losing pressure?'),
      assistant('The boiler pressure drops when the expansion vessel fails.'),
      user('pressure only'),
    ]);
    const r = index().search([c], 'BOILER pressure', 20);
    expect(r.total).toBe(1);
    const hit = r.hits[0]!;
    expect(hit.nameMatch).toBe(false);
    expect(hit.messageMatches).toBe(2);
    // The most recent matching message is the snippet.
    expect(hit.snippet).toMatchObject({ role: 'assistant' });
    expect(hit.snippet!.text).toBe('The boiler pressure drops when the expansion vessel fails.');
    expect(hit.snippet!.highlights).toEqual([
      [4, 10],
      [11, 19],
    ]);
    expect(hit.snippet!.createdAt).toBe(Date.parse('2026-09-01T10:00:05.000Z'));
  });

  it('treats a quoted run as an exact phrase, across a line break', () => {
    const c1 = chat({ chatId: 'c1' });
    const c2 = chat({ chatId: 'c2' });
    writeLog(c1, [user('the expansion vessel is split')]);
    writeLog(c2, [user('vessel for the expansion\nbut not in that order')]);
    const idx = index();
    expect(idx.search([c1, c2], 'expansion vessel', 20).total).toBe(2);
    const r = idx.search([c1, c2], '"expansion vessel"', 20);
    expect(r.hits.map((h) => h.chatId)).toEqual(['c1']);
    expect(r.hits[0]!.snippet!.highlights).toEqual([[4, 20]]);
    const wrapped = chat({ chatId: 'c3' });
    writeLog(wrapped, [user('the expansion\n  vessel')]);
    expect(idx.search([wrapped], '"expansion vessel"', 20).total).toBe(1);
    // A phrase and a plain term must both hold.
    expect(idx.search([c1], '"expansion vessel" split', 20).total).toBe(1);
    expect(idx.search([c1], '"expansion vessel" kettle', 20).total).toBe(0);
  });

  it('finds a chat by its chat id or session id, with or without full text', () => {
    const c = chat({
      chatId: 'a0e4c9bf-62ea-4dd2-863d-7236a0a433dd',
      name: 'Unrelated',
      claudeSessionId: 'sess-1234-abcd',
    });
    const other = chat({ chatId: 'zzzz', name: 'Other' });
    writeLog(c, [user('nothing relevant')]);
    writeLog(other, [user('nothing')]);
    for (const fullText of [true, false]) {
      const r = index().search([c, other], 'a0e4c9bf-62ea-4dd2-863d-7236a0a433dd', 20, fullText);
      expect(r.hits.map((h) => h.chatId)).toEqual([c.chatId]);
      expect(r.hits[0]).toMatchObject({ nameMatch: false, messageMatches: 0, snippet: null });
    }
    expect(index().search([c, other], 'A0E4C9BF', 20).total).toBe(1);
    expect(index().search([c, other], 'sess-1234', 20).hits[0]!.chatId).toBe(c.chatId);
    expect(index().search([c, other], 'a0e4c9bf 62ea', 20).total).toBe(0);
  });

  it('searches names only when fullText is false, reading no log', () => {
    const named = chat({ chatId: 'n', name: 'Garden plan' });
    const said = chat({ chatId: 's', name: 'Other', preview: 'garden preview' });
    writeLog(named, [user('nothing')]);
    writeLog(said, [user('the garden is wet')]);
    const idx = index();
    expect(
      idx
        .search([named, said], 'garden', 20, true)
        .hits.map((h) => h.chatId)
        .sort(),
    ).toEqual(['n', 's']);
    const r = idx.search([named, said], 'garden', 20, false);
    expect(r.hits.map((h) => h.chatId)).toEqual(['n']);
    expect(r.hits[0]).toMatchObject({ nameMatch: true, messageMatches: 0, snippet: null });
    expect(idx.search([named, said], '"garden plan"', 20, false).total).toBe(1);
    // A missing log is not "missing" when none was going to be read.
    const gone = chat({ chatId: 'g', name: 'garden gone' });
    expect(index().search([gone], 'garden', 20, false).transcriptsMissing).toBe(0);
  });

  it('leaves archived chats out unless includeArchived is set', () => {
    const live = chat({ chatId: 'live', name: 'Garden live' });
    const old = chat({ chatId: 'old', name: 'Garden old', status: 'archived' });
    writeLog(live, [user('nothing')]);
    writeLog(old, [user('nothing')]);
    const idx = index();
    expect(idx.search([live, old], 'garden', 20).hits.map((h) => h.chatId)).toEqual(['live']);
    expect(idx.search([live, old], 'garden', 20, false, false).total).toBe(1);
    expect(
      idx
        .search([live, old], 'garden', 20, true, true)
        .hits.map((h) => h.chatId)
        .sort(),
    ).toEqual(['live', 'old']);
  });

  it('leaves hidden chats out unless includeHidden is set', () => {
    const live = chat({ chatId: 'live', name: 'Garden live' });
    const tucked = chat({ chatId: 'tucked', name: 'Garden tucked', hidden: true });
    writeLog(live, [user('nothing')]);
    writeLog(tucked, [user('nothing')]);
    const idx = index();
    expect(idx.search([live, tucked], 'garden', 20).hits.map((h) => h.chatId)).toEqual(['live']);
    expect(
      idx
        .search([live, tucked], 'garden', 20, true, false, true)
        .hits.map((h) => h.chatId)
        .sort(),
    ).toEqual(['live', 'tucked']);
  });

  it('does not search tool calls, tool output or thinking', () => {
    const c = chat({ chatId: 'c1' });
    writeLog(c, [
      user('list the files'),
      toolUse('t1', { command: 'cat secret-kumquat.txt' }),
      toolResult('t1', 'kumquat '.repeat(20_000)),
      thinking('the kumquat file'),
      assistant('Done.'),
    ]);
    expect(index().search([c], 'kumquat', 20).total).toBe(0);
  });

  it('orders hits by most recent activity, name match or not', () => {
    const older = chat({ chatId: 'old', name: 'Garden plan', lastUpdated: NOW - 5000 });
    const newer = chat({ chatId: 'new', lastUpdated: NOW - 10 });
    const middle = chat({ chatId: 'mid', lastUpdated: NOW - 100 });
    writeLog(older, [user('nothing here')]);
    writeLog(newer, [assistant('the garden needs water')]);
    writeLog(middle, [user('garden gnomes')]);
    const r = index().search([middle, newer, older], 'garden', 20);
    expect(r.hits.map((h) => h.chatId)).toEqual(['new', 'mid', 'old']);
    expect(r.hits[2]!).toMatchObject({ nameMatch: true, nameHighlights: [[0, 6]], snippet: null });
  });

  it('labels every section and never searches a deleted chat', () => {
    const chats = [
      chat({ chatId: 'thread_manager', name: 'Manager moss' }),
      chat({ chatId: 'thread_speakers', name: 'Speakers moss' }),
      chat({ chatId: 'arch', name: 'moss archived', status: 'archived' }),
      chat({ chatId: 'snz', name: 'moss snoozed', snoozedUntil: NOW + 60_000 }),
      chat({ chatId: 'lapsed', name: 'moss lapsed snooze', snoozedUntil: NOW - 60_000 }),
      chat({ chatId: 'pin', name: 'moss pinned', pinned: true }),
      chat({ chatId: 'del', name: 'moss deleted', status: 'deleted' }),
    ];
    const r = index().search(chats, 'moss', 20, true, true);
    const sections = Object.fromEntries(r.hits.map((h) => [h.chatId, h.section]));
    expect(sections).toEqual({
      thread_manager: 'manager',
      thread_speakers: 'channels',
      arch: 'archived',
      snz: 'snoozed',
      lapsed: 'folders',
      pin: 'pinned',
    });
    expect(r.searchedChats).toBe(6);
    expect(r.hits.every((h) => h.hostId === 'host-a')).toBe(true);
  });

  it('finds a message appended after the last search, and waits for an unfinished line', () => {
    const c = chat({ chatId: 'c1' });
    writeLog(c, [user('first message')]);
    const idx = index();
    expect(idx.search([c], 'walnut', 20).total).toBe(0);
    // Half a line: the backend is still writing it.
    const line = assistant('a walnut tree');
    appendFileSync(logPath(c), line.slice(0, 20));
    expect(idx.search([c], 'walnut', 20).total).toBe(0);
    appendFileSync(logPath(c), `${line.slice(20)}\n`);
    const r = idx.search([c], 'walnut', 20);
    expect(r.total).toBe(1);
    expect(r.hits[0]!.snippet!.text).toBe('a walnut tree');
    // Nothing is counted twice across incremental reads.
    expect(idx.search([c], 'message', 20).hits[0]!.messageMatches).toBe(1);
  });

  it('re-reads a log that was rewritten shorter', () => {
    const c = chat({ chatId: 'c1' });
    writeLog(c, [user('alpha one'), user('alpha two'), user('alpha three')]);
    const idx = index();
    expect(idx.search([c], 'alpha', 20).hits[0]!.messageMatches).toBe(3);
    writeLog(c, [user('alpha only')]);
    expect(idx.search([c], 'alpha', 20).hits[0]!.messageMatches).toBe(1);
  });

  it("searches only the chat's current track when it has branched", () => {
    const c = chat({
      chatId: 'c1',
      track: [
        { branchId: 'b1', upperBound: Number.POSITIVE_INFINITY },
        { branchId: 'b0', upperBound: 0 },
      ],
    });
    writeLog(c, [
      record({ type: 'chat.message', role: 'user', content: 'shared otter' }, 0),
      record({ type: 'chat.message', role: 'user', content: 'original otter' }, 1),
      record({ type: 'chat.message', role: 'user', content: 'edited otter' }, 2, 'b1'),
      record({ type: 'chat.message', role: 'user', content: 'side otter' }, 3, 'b2'),
    ]);
    const hit = index().search([c], 'otter', 20).hits[0]!;
    expect(hit.messageMatches).toBe(2);
    expect(hit.snippet!.text).toBe('edited otter');
  });

  it('a later entry at the same seq on the same branch replaces the earlier one', () => {
    const c = chat({ chatId: 'c1' });
    writeLog(c, [
      record({ type: 'chat.message', role: 'user', content: 'draft walrus' }, 3),
      record({ type: 'chat.message', role: 'user', content: 'final heron' }, 3),
      record({ type: 'chat.message', role: 'user', content: 'other branch walrus' }, 3, 'b1'),
    ]);
    const idx = index();
    expect(idx.search([c], 'heron', 20).total).toBe(1);
    expect(idx.search([c], 'walrus', 20).hits[0]!.messageMatches).toBe(1);
  });

  it('counts a chat whose log is missing, and still matches its stored preview', () => {
    const gone = chat({ chatId: 'gone', preview: 'Plan the Cornwall trip' });
    const r = index().search([gone], 'cornwall', 20);
    expect(r.transcriptsMissing).toBe(1);
    expect(r.total).toBe(1);
    expect(r.hits[0]!.snippet).toEqual({
      text: 'Plan the Cornwall trip',
      highlights: [[9, 17]],
      role: 'user',
      seq: null,
      createdAt: null,
    });
  });

  it("carries the matched message's own seq", () => {
    const c = chat({ chatId: 'c1' });
    writeLog(c, [user('yes'), assistant('ok'), user('yes'), assistant('otter found')]);
    const idx = index();
    expect(idx.search([c], 'yes', 20).hits[0]!.snippet!.seq).toBe(2);
    expect(idx.search([c], 'otter', 20).hits[0]!.snippet!.seq).toBe(3);
  });

  it('reports and skips a corrupt line', () => {
    const c = chat({ chatId: 'c1' });
    writeLog(c, [
      user('before'),
      '{"v":1,"rec":{"k":"event","event":{"type":"chat.message", not json',
      user('after heron'),
    ]);
    const r = index().search([c], 'heron', 20);
    expect(r.total).toBe(1);
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0]!.path).toBe(logPath(c));
  });

  it('indexes every provider the same way, from the record alone', () => {
    const c = chat({ chatId: 'cx', claudeSessionId: 'codex-abc' });
    writeLog(c, [user('tell me about lichen'), toolUse('k', { q: 'lichen' })]);
    const r = index().search([c], 'lichen', 20);
    expect(r.hits[0]!.messageMatches).toBe(1);
    expect(r.hits[0]!.snippet).toMatchObject({ role: 'user' });
  });

  it('returns the top `limit` hits and the full total', () => {
    const chats = Array.from({ length: 5 }, (_, i) =>
      chat({ chatId: `c${i}`, name: `fern ${i}`, lastUpdated: NOW - i }),
    );
    const r = index().search(chats, 'fern', 2);
    expect(r.total).toBe(5);
    expect(r.hits.map((h) => h.chatId)).toEqual(['c0', 'c1']);
  });

  it('warm() builds the index for every live chat', async () => {
    const a = chat({ chatId: 'a' });
    const d = chat({ chatId: 'd', status: 'deleted' });
    writeLog(a, [user('x')]);
    writeLog(d, [user('y')]);
    const idx = index();
    await idx.warm([a, d]);
    expect(idx.size()).toBe(1);
  });
});

describe('snippets and highlights', () => {
  it('splits a query into distinct lowercase terms', () => {
    expect(queryTerms('  Foo  bar foo ')).toEqual(['foo', 'bar']);
  });

  it('merges overlapping ranges', () => {
    expect(highlightRanges('abcabc', ['abc', 'bca'])).toEqual([[0, 6]]);
    expect(highlightRanges('a.b a+b', ['a.b', 'a+b'])).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });

  it('windows a long message around the match, marking cut ends', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`);
    words[50] = 'NEEDLE';
    const s = makeSnippet(words.join('\n  '), ['needle']);
    expect(s.text.startsWith('…')).toBe(true);
    expect(s.text.endsWith('…')).toBe(true);
    expect(s.text).not.toMatch(/\s{2}|\n/);
    expect(s.highlights).toHaveLength(1);
    const [start, end] = s.highlights[0]!;
    expect(s.text.slice(start, end)).toBe('NEEDLE');
    // Cut on word boundaries.
    expect(s.text).toMatch(/^…word\d+ /);
    expect(s.text).toMatch(/ word\d+…$/);
  });

  it('keeps a short message whole', () => {
    expect(makeSnippet('short and sweet', ['sweet'])).toEqual({
      text: 'short and sweet',
      highlights: [[10, 15]],
    });
  });
});

describe('handleChatSearchRequest', () => {
  const logger = { info: () => {}, error: () => {} };

  it('waits for the index build, then answers once with the hits', async () => {
    const c = chat({ chatId: 'c1', name: 'Birch' });
    let release: () => void = () => {};
    const ready = new Promise<void>((r) => (release = r));
    const sent: WireEvent[] = [];
    const done = handleChatSearchRequest(
      {
        type: 'patch.chat_search.request',
        requestId: 'r1',
        hostId: 'host-a',
        query: 'birch',
        limit: 5,
      },
      { index: index(), ready, listChats: () => [c], hostId: 'host-a', logger },
      (e) => sent.push(e),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(0);
    release();
    await done;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'patch.chat_search.response',
      requestId: 'r1',
      hostId: 'host-a',
      ok: true,
      total: 1,
      searchedChats: 1,
      transcriptsMissing: 1,
    });
  });

  it('passes fullText from the request to the search', async () => {
    const c = chat({ chatId: 'c1', name: 'Other' });
    writeLog(c, [user('the walnut tree')]);
    const ask = async (fullText: boolean | undefined): Promise<number> => {
      const sent: WireEvent[] = [];
      await handleChatSearchRequest(
        {
          type: 'patch.chat_search.request',
          requestId: 'r',
          hostId: 'host-a',
          query: 'walnut',
          limit: 5,
          ...(fullText === undefined ? {} : { fullText }),
        },
        {
          index: index(),
          ready: Promise.resolve(),
          listChats: () => [c],
          hostId: 'host-a',
          logger,
        },
        (e) => sent.push(e),
      );
      return (sent[0] as { total: number }).total;
    };
    expect(await ask(undefined)).toBe(1);
    expect(await ask(true)).toBe(1);
    expect(await ask(false)).toBe(0);
  });

  it('answers a failure as ok:false with the reason', async () => {
    const sent: WireEvent[] = [];
    await handleChatSearchRequest(
      {
        type: 'patch.chat_search.request',
        requestId: 'r2',
        hostId: 'host-a',
        query: 'oak',
        limit: 5,
      },
      {
        index: index(),
        ready: Promise.resolve(),
        listChats: () => {
          throw new Error('chat list unreadable');
        },
        hostId: 'host-a',
        logger,
      },
      (e) => sent.push(e),
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'internal' } });
  });
});
