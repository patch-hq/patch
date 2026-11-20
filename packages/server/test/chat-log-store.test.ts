// The server's copy of each chat's transcript (spec/01 § Message log): what
// passes through is kept, so a chat on a host that is asleep stays readable.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { ChatLogStore } from '../src/chat-log-store.js';

const logger = pino({ level: 'silent' });

const message = (chatId: string, seq: number, content = `m${seq}`): WireEvent =>
  ({ type: 'chat.message', chatId, role: 'assistant', content, seq }) as WireEvent;

describe('ChatLogStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-chatlog-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('makeDurable throws after a failed write, and a resend of that event is then committed', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.commit(message('c1', 1));
    store.makeDurable();
    // The chat's file cannot be written: a directory stands where it should be.
    const file = join(dir, 'chat-logs', 'c2.jsonl');
    mkdirSync(file);
    expect(store.commit(message('c2', 1))).toBe('new');
    expect(() => store.makeDurable()).toThrow();
    // Said once: the next acknowledgement is not refused for an old failure.
    expect(() => store.makeDurable()).not.toThrow();
    rmSync(file, { recursive: true });
    // Not taken as a duplicate of what only memory held.
    expect(store.commit(message('c2', 1))).toBe('new');
    store.makeDurable();
    expect(new ChatLogStore({ dataDir: dir, logger }).read('c2', -1)).toHaveLength(1);
  });

  test('reads back what passed through, in seq order, after the given seq', () => {
    const store = new ChatLogStore({ logger });
    for (const seq of [3, 1, 2]) store.observe(message('c1', seq));
    expect(store.read('c1', -1).map((e) => (e as { seq: number }).seq)).toEqual([1, 2, 3]);
    expect(store.read('c1', 1).map((e) => (e as { seq: number }).seq)).toEqual([2, 3]);
    expect(store.read('c1', -1, 2)).toHaveLength(2);
    expect(store.read('other', -1)).toEqual([]);
    expect(store.has('c1')).toBe(true);
    expect(store.has('other')).toBe(false);
  });

  test('keeps the transcript and ignores live-only frames', () => {
    const store = new ChatLogStore({ logger });
    store.observe({
      type: 'chat.message_delta',
      chatId: 'c1',
      messageSeq: 1,
      delta: 'x',
    } as WireEvent);
    store.observe({
      type: 'chat.queued',
      chatId: 'c1',
      localId: 'l',
      message: 'q',
      queueSeq: 1,
    } as WireEvent);
    store.observe({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 2,
      tool: 'Bash',
      args: {},
      callId: 'k',
    } as WireEvent);
    expect(store.read('c1', -1).map((e) => e.type)).toEqual(['chat.tool_call']);
  });

  test('the same event seen twice is held once, and a later version replaces it', () => {
    const store = new ChatLogStore({ logger });
    store.observe(message('c1', 1, 'first'));
    store.observe(message('c1', 1, 'first'));
    store.observe(message('c1', 1, 'second'));
    const held = store.read('c1', -1);
    expect(held).toHaveLength(1);
    expect((held[0] as { content: string }).content).toBe('second');
  });

  test('drops the routing tag a replayed event carries', () => {
    const store = new ChatLogStore({ logger });
    store.observe({ ...message('c1', 1), forSurfaceId: 'srf-1' } as WireEvent);
    expect('forSurfaceId' in (store.read('c1', -1)[0] as object)).toBe(false);
  });

  test('survives a restart, and ignores a torn last line', async () => {
    const first = new ChatLogStore({ dataDir: dir, logger });
    first.observe(message('c1', 1));
    first.observe(message('c1', 2));
    await first.flush();

    appendFileSync(join(dir, 'chat-logs', 'c1.jsonl'), '{"type":"chat.message","chatId":"c1","se');
    const second = new ChatLogStore({ dataDir: dir, logger });
    expect(second.read('c1', -1).map((e) => (e as { seq: number }).seq)).toEqual([1, 2]);
  });

  test('an event committed after a torn last line is not lost with it', () => {
    const first = new ChatLogStore({ dataDir: dir, logger });
    first.observe(message('c1', 0));
    appendFileSync(join(dir, 'chat-logs', 'c1.jsonl'), '{"type":"chat.message","chatId":"c1","ro');

    const second = new ChatLogStore({ dataDir: dir, logger });
    second.observe(message('c1', 1));

    const third = new ChatLogStore({ dataDir: dir, logger });
    expect(third.highWater('c1')).toBe(1);
    expect(third.read('c1', -1).map((e) => (e as { seq: number }).seq)).toEqual([0, 1]);
  });

  test('an unchanged event is not written again', async () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.observe(message('c1', 1));
    store.observe(message('c1', 1));
    await store.flush();
    expect(
      readFileSync(join(dir, 'chat-logs', 'c1.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(1);
  });

  test('a chat id cannot escape the log directory', async () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.observe(message('../../evil', 1));
    await store.flush();
    expect(readFileSync(join(dir, 'chat-logs', '______evil.jsonl'), 'utf8')).toContain('"seq":1');
  });

  test('commit says what it did: new, a resend, an update, a contradiction', () => {
    const store = new ChatLogStore({ logger });
    expect(store.commit(message('c1', 1, 'first'))).toBe('new');
    expect(store.commit(message('c1', 1, 'first'))).toBe('duplicate');
    expect(store.commit(message('c1', 1, 'edited'))).toBe('updated');
    // A tool call is a different event from the message that holds seq 1.
    expect(
      store.commit({
        type: 'chat.tool_call',
        chatId: 'c1',
        seq: 1,
        tool: 'Bash',
        args: {},
        callId: 'k',
      } as WireEvent),
    ).toBe('conflict');
    // The contradiction kept nothing and left the held message alone.
    expect((store.read('c1', -1)[0] as { content: string }).content).toBe('edited');
    expect(
      store.commit({
        type: 'chat.message_delta',
        chatId: 'c1',
        messageSeq: 1,
        delta: 'x',
      } as WireEvent),
    ).toBe('ignored');
    expect(store.commit({ ...message('c1', 2), seq: -1 } as WireEvent)).toBe('ignored');
  });

  test('is on disk the moment commit returns', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.commit(message('c1', 1));
    expect(readFileSync(join(dir, 'chat-logs', 'c1.jsonl'), 'utf8')).toContain('"seq":1');
    // Another process starting now reads it back.
    expect(new ChatLogStore({ dataDir: dir, logger }).highWater('c1')).toBe(1);
  });

  test("a person's own message is also fsynced, and written once", () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.commit({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'hi',
      seq: 0,
    } as WireEvent);
    expect(
      readFileSync(join(dir, 'chat-logs', 'c1.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(1);
  });

  test('load target: the last screen of a long chat is answered well within a second (spec/19)', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    for (let seq = 0; seq < 20_000; seq++) store.commit(message('c1', seq));
    const fresh = new ChatLogStore({ dataDir: dir, logger });
    const started = performance.now();
    const page = fresh.page('c1', { limit: 100 });
    const tookMs = performance.now() - started;
    expect(page.entries).toHaveLength(100);
    expect(page.more).toBe(true);
    expect(tookMs).toBeLessThan(1000);
  });

  test('highWater is the highest seq held, or -1 for a chat it holds nothing for', () => {
    const store = new ChatLogStore({ logger });
    expect(store.highWater('c1')).toBe(-1);
    store.commit(message('c1', 3));
    store.commit(message('c1', 9));
    store.commit(message('c1', 5));
    expect(store.highWater('c1')).toBe(9);
  });

  test("a turn's closing summary and an artifact are kept; a running label is not", () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.commit(message('c1', 1));
    const summary = (seq: number, live?: true) =>
      ({
        type: 'chat.tool_run_summary',
        chatId: 'c1',
        callIds: ['t1'],
        summary: 's',
        seq,
        ...(live ? { live } : {}),
      }) as WireEvent;
    expect(store.commit(summary(2, true))).toBe('ignored');
    expect(store.commit(summary(2))).toBe('new');
    const artifact = {
      type: 'chat.artifact',
      chatId: 'c1',
      artifactId: 'a1',
      title: 'Report',
      url: '/a/1',
      path: 'r.html',
      updatedAt: 5,
      seq: 3,
    } as WireEvent;
    expect(store.commit(artifact)).toBe('new');
    expect(store.commit({ ...artifact, updatedAt: 6 } as WireEvent)).toBe('updated');
    expect(new ChatLogStore({ dataDir: dir, logger }).read('c1', -1).map((e) => e.type)).toEqual([
      'chat.message',
      'chat.tool_run_summary',
      'chat.artifact',
    ]);
  });

  test("a question and its answer replay at the question's seq; an open one is left to the host", () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.commit(message('c1', 1));
    store.commit(message('c1', 4));
    const ask = (requestId: string, seq: number) =>
      ({
        type: 'chat.permission_request',
        chatId: 'c1',
        requestId,
        request: { tool: 'AskUserQuestion', args: { questions: [] } },
        seq,
      }) as WireEvent;
    store.notePermission(ask('q1', 2));
    store.notePermission(ask('q2', 3));
    store.notePermission({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'p1',
      request: { tool: 'Bash', args: {} },
      seq: 3,
    } as WireEvent);
    store.notePermission({
      type: 'chat.permission_response',
      chatId: 'c1',
      requestId: 'q1',
      approve: true,
      decision: 'approve_with_edits',
      answers: { pick: 'A' },
    } as WireEvent);
    const shape = (s: ChatLogStore) =>
      s.replay('c1', -1).map((e) => `${e.type}:${(e as { seq?: number }).seq ?? '-'}`);
    const expected = [
      'chat.message:1',
      'chat.permission_request:2',
      'chat.permission_response:-',
      'chat.message:4',
    ];
    expect(shape(store)).toEqual(expected);
    expect(shape(new ChatLogStore({ dataDir: dir, logger }))).toEqual(expected);
    expect(store.replay('c1', 2).map((e) => e.type)).toEqual(['chat.message']);
  });

  test('a reach is only noted for a chat it holds, and never lowers the mark', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.noteReach('c1', 5);
    expect(store.highWater('c1')).toBe(-1);
    expect(store.has('c1')).toBe(false);
    store.commit(message('c1', 4));
    store.noteReach('c1', 2);
    expect(store.highWater('c1')).toBe(4);
    store.noteReach('c1', 6);
    store.commit(message('c1', 8));
    expect(store.highWater('c1')).toBe(8);
    expect(new ChatLogStore({ dataDir: dir, logger }).highWater('c1')).toBe(8);
  });

  test('a batched replay is kept event by event', () => {
    const store = new ChatLogStore({ logger });
    store.observe({
      type: 'chat.replay_batch',
      chatId: 'c1',
      events: [message('c1', 1), message('c1', 2)],
      done: true,
    } as WireEvent);
    expect(store.read('c1', -1)).toHaveLength(2);
  });

  describe('large tool results', () => {
    const result = (chatId: string, seq: number, body: unknown): WireEvent =>
      ({
        type: 'chat.tool_result',
        chatId,
        callId: `k${seq}`,
        tool: 'Bash',
        result: body,
        seq,
      }) as WireEvent;
    const big = 'x'.repeat(10_000);

    test('are kept as a reference to a stored body, and the body can be read back', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      store.commit(result('c1', 1, [{ type: 'text', text: big }]));
      const held = (store.read('c1', -1)[0] as { result: Record<string, unknown> }).result;
      expect(held).toMatchObject({ bytes: expect.any(Number), mime: 'application/json' });
      expect(String(held['$blob'])).toMatch(/^[0-9a-f]{64}$/);
      expect(String(held['preview']).length).toBeLessThanOrEqual(200);
      const body = store.readBlob(String(held['$blob']))!;
      expect(JSON.parse(body.bytes.toString('utf8'))).toEqual([{ type: 'text', text: big }]);
      // The log line itself is small.
      expect(readFileSync(join(dir, 'chat-logs', 'c1.jsonl'), 'utf8').length).toBeLessThan(1_000);
    });

    test('leave a small result inline', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      store.commit(result('c1', 1, 'ok'));
      expect((store.read('c1', -1)[0] as { result: string }).result).toBe('ok');
    });

    test('a resend of a big result is a duplicate, and the body is stored once', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      expect(store.commit(result('c1', 1, big))).toBe('new');
      expect(store.commit(result('c1', 1, big))).toBe('duplicate');
      expect(store.commit(result('c2', 1, big))).toBe('new'); // same body, another chat
    });

    test('survive a restart', () => {
      const first = new ChatLogStore({ dataDir: dir, logger });
      first.commit(result('c1', 1, big));
      const ref = (first.read('c1', -1)[0] as { result: { $blob: string } }).result.$blob;
      const second = new ChatLogStore({ dataDir: dir, logger });
      expect(second.readBlob(ref)).not.toBeNull();
      expect((second.read('c1', -1)[0] as { result: { $blob: string } }).result.$blob).toBe(ref);
    });

    test('a reference the host already made is kept as it is', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      const ref = { $blob: 'a'.repeat(64), bytes: 9_999, mime: 'application/json', preview: 'p' };
      store.commit(result('c1', 1, ref));
      expect((store.read('c1', -1)[0] as { result: unknown }).result).toEqual(ref);
      expect(store.readBlob('a'.repeat(64))).toBeNull(); // the body is the host's to give
    });

    test('are kept inline when there is nowhere to store a body', () => {
      const store = new ChatLogStore({ logger });
      store.commit(result('c1', 1, big));
      expect((store.read('c1', -1)[0] as { result: string }).result).toBe(big);
    });

    test('a result that is missing or null is small, so it stays as it is', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      store.commit(result('c1', 1, null));
      store.commit({
        type: 'chat.tool_result',
        chatId: 'c1',
        callId: 'k2',
        tool: 'T',
        seq: 2,
      } as WireEvent);
      const held = store.read('c1', -1) as Array<{ result?: unknown }>;
      expect(held[0]!.result).toBeNull();
      expect('result' in held[1]!).toBe(false);
    });

    test('only a well-formed hash is looked up', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      expect(store.readBlob('../../etc/passwd')).toBeNull();
      expect(store.readBlob('nothex')).toBeNull();
    });
  });

  describe('what it does when things go wrong or are odd', () => {
    const warnings = (): { logger: { warn: (o: unknown, m?: string) => void }; seen: string[] } => {
      const seen: string[] = [];
      return { logger: { warn: (_o, m) => seen.push(String(m)) }, seen };
    };
    const toolResult = (seq: number, body: unknown): WireEvent =>
      ({
        type: 'chat.tool_result',
        chatId: 'c1',
        callId: `k${seq}`,
        tool: 'T',
        result: body,
        seq,
      }) as WireEvent;
    const previewOfStored = (store: ChatLogStore): string =>
      (store.read('c1', -1)[0] as { result: { preview: string } }).result.preview;

    test('keeps only the newest events of a chat in memory, up to the cap', () => {
      const store = new ChatLogStore({ logger, maxEventsPerChat: 3 });
      for (let seq = 1; seq <= 5; seq++) store.commit(message('c1', seq));
      expect(store.read('c1', -1).map((e) => (e as { seq: number }).seq)).toEqual([3, 4, 5]);
    });

    test('holds a chat loaded from disk to the cap too, keeping its newest events', () => {
      mkdirSync(join(dir, 'chat-logs'), { recursive: true });
      writeFileSync(
        join(dir, 'chat-logs', 'c1.jsonl'),
        [5, 1, 4, 2, 3].map((seq) => `${JSON.stringify(message('c1', seq))}\n`).join(''),
      );
      const store = new ChatLogStore({ dataDir: dir, logger, maxEventsPerChat: 3 });
      expect(store.read('c1', -1).map((e) => (e as { seq: number }).seq)).toEqual([3, 4, 5]);
    });

    test('drops the oldest event of a chat too long to spread into an argument list', () => {
      const store = new ChatLogStore({ logger, maxEventsPerChat: 200_000 });
      for (let seq = 200_000; seq >= 1; seq--) store.commit(message('c1', seq));
      expect(store.commit(message('c1', 200_001))).toBe('new');
      expect(store.read('c1', -1, 1)).toEqual([message('c1', 2)]);
    });

    test('keeps a note to the agent as a transcript entry, apart from a message at another seq', () => {
      const store = new ChatLogStore({ logger });
      const note = {
        type: 'chat.note',
        chatId: 'c1',
        label: 'Hidden',
        text: 't',
        seq: 1,
      } as WireEvent;
      expect(store.commit(note)).toBe('new');
      expect(store.commit(note)).toBe('duplicate');
      expect(
        store.commit({
          type: 'chat.message',
          chatId: 'c1',
          role: 'user',
          content: 'hi',
          seq: 2,
        } as WireEvent),
      ).toBe('new');
    });

    test('tells a provider context apart from an error at the same seq', () => {
      const store = new ChatLogStore({ logger });
      store.commit({
        type: 'chat.provider_context',
        chatId: 'c1',
        providerType: 'x',
        text: 't',
        seq: 1,
      } as WireEvent);
      expect(
        store.commit({
          type: 'chat.error',
          chatId: 'c1',
          error: { code: 'internal', message: 'm' },
          seq: 1,
        } as WireEvent),
      ).toBe('conflict');
    });

    test('previews a big text result by its start, cut to 200 characters', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      store.commit(toolResult(1, 'a'.repeat(9_000)));
      expect(previewOfStored(store)).toBe('a'.repeat(200));
    });

    test('a preview cut at 200 characters does not split an emoji', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      store.commit(toolResult(1, `${'a'.repeat(199)}😀${'b'.repeat(9_000)}`));
      expect(previewOfStored(store)).toBe(`${'a'.repeat(199)}😀`);
    });

    test('previews a big block result by its text blocks, with [image] for a picture and nothing for the rest', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      store.commit(
        toolResult(1, [
          'a bare string block',
          null,
          { type: 'image', source: {} },
          { type: 'text', text: 'first line' },
          { type: 'text', text: 7 },
          { type: 'text', text: 'x'.repeat(9_000) },
        ]),
      );
      const preview = previewOfStored(store);
      expect(preview.startsWith('[image]\nfirst line\nxxx')).toBe(true);
      expect(preview).toHaveLength(200);
    });

    test('previews a big result that has no text blocks by its JSON', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      store.commit(toolResult(1, { rows: Array.from({ length: 2_000 }, (_, i) => i) }));
      expect(previewOfStored(store).startsWith('{"rows":[0,1,2')).toBe(true);
    });

    test('keeps a big result inline, and says so, when its body cannot be stored', () => {
      const { logger: l, seen } = warnings();
      mkdirSync(join(dir, 'chat-logs'), { recursive: true });
      writeFileSync(join(dir, 'chat-logs', 'blobs'), 'in the way'); // a file where the blob directory goes
      const store = new ChatLogStore({ dataDir: dir, logger: l });
      const body = 'z'.repeat(9_000);
      expect(store.commit(toolResult(1, body))).toBe('new');
      expect((store.read('c1', -1)[0] as { result: string }).result).toBe(body);
      expect(seen.join(' ')).toContain('could not store a large result');
    });

    test('says so, holds nothing it could not write, and refuses the next acknowledgement', () => {
      const { logger: l, seen } = warnings();
      mkdirSync(join(dir, 'chat-logs', 'c1.jsonl'), { recursive: true }); // a directory where the file goes
      const store = new ChatLogStore({ dataDir: dir, logger: l });
      expect(store.commit(message('c1', 1))).toBe('new');
      expect(
        store.commit({
          type: 'chat.message',
          chatId: 'c1',
          role: 'user',
          content: 'hi',
          seq: 2,
        } as WireEvent),
      ).toBe('new');
      expect(seen.filter((m) => m.includes('could not write the chat log'))).toHaveLength(2);
      // Memory never holds what the disk does not: the host resends it.
      expect(store.read('c1', -1)).toHaveLength(0);
      expect(() => store.makeDurable()).toThrow();
    });

    test("says so, and starts empty, when a chat's log file cannot be read", () => {
      const { logger: l, seen } = warnings();
      mkdirSync(join(dir, 'chat-logs', 'c1.jsonl'), { recursive: true });
      const store = new ChatLogStore({ dataDir: dir, logger: l });
      expect(store.has('c1')).toBe(false);
      expect(seen.join(' ')).toContain('could not read the chat log');
    });

    test('skips blank lines and records without a seq when reading a log back', () => {
      mkdirSync(join(dir, 'chat-logs'), { recursive: true });
      writeFileSync(
        join(dir, 'chat-logs', 'c1.jsonl'),
        [
          '',
          JSON.stringify({
            type: 'chat.message',
            chatId: 'c1',
            role: 'user',
            content: 'a',
            seq: 4,
          }),
          '{"type":"chat.message"}',
          '',
        ].join('\n'),
      );
      const store = new ChatLogStore({ dataDir: dir, logger });
      expect(store.read('c1', -1).map((e) => (e as { seq: number }).seq)).toEqual([4]);
    });

    test('flush resolves at once, since every write was already made', async () => {
      await expect(new ChatLogStore({ logger }).flush()).resolves.toBeUndefined();
    });
  });
});

describe('ChatLogStore: turn boundaries and provider ids (spec/01 § Chat record)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-chatlog-record-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const ref = { harness: 'claude' as const, sessionId: 'S1', id: 'u-1' };
  const started = (turnId: string, seq: number, at = 1): WireEvent =>
    ({ type: 'chat.turn_started', chatId: 'c1', turnId, seq, at, origin: 'user' }) as WireEvent;
  const ended = (turnId: string, seq: number, outcome = 'completed', at = 2): WireEvent =>
    ({ type: 'chat.turn_ended', chatId: 'c1', turnId, seq, at, outcome }) as WireEvent;
  const withRef = (seq: number, r = ref): WireEvent =>
    ({ ...message('c1', seq), nativeRef: r }) as WireEvent;

  test('keeps turn boundaries by turn id, durably, in the order the turns began', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    expect(store.commit(started('t2', 1, 5))).toBe('new');
    expect(store.commit(started('t1', -1))).toBe('new');
    expect(store.commit(ended('t1', 1))).toBe('new');
    expect(store.commit(ended('t1', 1))).toBe('duplicate');
    // A boundary takes no seq: it never collides with the entry at its seq.
    expect(store.commit(message('c1', 1))).toBe('new');
    expect(store.read('c1', -1)).toHaveLength(1);

    const reopened = new ChatLogStore({ dataDir: dir, logger });
    const turns = reopened.turns('c1');
    expect(turns.map((t) => t.turnId)).toEqual(['t1', 't2']);
    expect(turns[0]!.ended).toMatchObject({ outcome: 'completed', seq: 1 });
    expect(turns[1]!.ended).toBeUndefined();
    expect(reopened.read('c1', -1)).toHaveLength(1);
  });

  test("a turn's end said again with a different outcome replaces it", () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.commit(started('t1', 0));
    store.commit(ended('t1', 0, 'interrupted'));
    expect(store.commit(ended('t1', 0, 'failed', 3))).toBe('updated');
    expect(new ChatLogStore({ dataDir: dir, logger }).turns('c1')[0]!.ended?.outcome).toBe(
      'failed',
    );
  });

  test('keeps the provider id beside the entry, and never in what it reads out', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    expect(store.commit(withRef(0))).toBe('new');
    expect(store.nativeRef('c1', 0)).toEqual(ref);
    expect(store.read('c1', -1)[0]).toEqual(message('c1', 0));
    expect(store.replay('c1', -1)[0]).not.toHaveProperty('nativeRef');
    expect(store.page('c1', { limit: 10 }).entries[0]).not.toHaveProperty('nativeRef');
    const reopened = new ChatLogStore({ dataDir: dir, logger });
    expect(reopened.nativeRef('c1', 0)).toEqual(ref);
    expect(reopened.read('c1', -1)[0]).toEqual(message('c1', 0));
  });

  test('an entry it holds, sent again with its provider id, gains it without being new to surfaces', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.commit(message('c1', 0));
    expect(store.commit(withRef(0))).toBe('duplicate');
    expect(store.commit(withRef(0))).toBe('duplicate');
    expect(new ChatLogStore({ dataDir: dir, logger }).nativeRef('c1', 0)).toEqual(ref);
  });

  test('a resend without the provider id does not take it away', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.commit(withRef(0));
    expect(store.commit(message('c1', 0))).toBe('duplicate');
    expect(store.commit(message('c1', 0, 'edited'))).toBe('updated');
    expect(store.nativeRef('c1', 0)).toEqual(ref);
    expect(new ChatLogStore({ dataDir: dir, logger }).nativeRef('c1', 0)).toEqual(ref);
  });

  test('a different entry at a held seq is still refused, provider id or not', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.commit(withRef(0));
    const other = {
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'x',
      seq: 0,
      nativeRef: { ...ref, id: 'u-2' },
    } as WireEvent;
    expect(store.commit(other)).toBe('conflict');
    expect(store.nativeRef('c1', 0)).toEqual(ref);
  });

  test('a record import of a chat it has never seen takes every entry and boundary', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.observe({
      type: 'chat.replay_batch',
      chatId: 'c1',
      events: [started('t1', -1), withRef(0), message('c1', 1), ended('t1', 1)],
    } as WireEvent);
    expect(store.read('c1', -1).map((e) => (e as { seq: number }).seq)).toEqual([0, 1]);
    expect(store.turns('c1')).toHaveLength(1);
    expect(store.nativeRef('c1', 0)).toEqual(ref);
  });
});
