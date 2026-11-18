// The host's half of the server's whole record (spec/01 § Chat record): turn
// boundaries and provider ids leave the host with the entries they belong to,
// live and in the one-time import.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { isOutboxEvent, type LogRecord, type WireEvent } from '@patch/wire';
import { ChatLog } from '../src/chatLog.js';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { recordEntries, turnBoundaryOf } from '../src/recordEntries.js';

const silent = pino({ level: 'silent' });
const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeLog(home: string) {
  return new ChatLog({
    chatDir: (id) => join(home, 'chats', id),
    blobsDir: join(home, 'blobs'),
    logger: silent,
    now: () => 1_700_000_000_000,
  });
}

const BIG = 'y'.repeat(10_000);

async function runOneTurn() {
  const home = tmp('record-complete-');
  const folder = tmp('record-complete-folder-');
  const sdk = createMockSdkBackend();
  const events: WireEvent[] = [];
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
  });
  sdk.enqueue([
    { type: 'system', sessionId: 'S1' },
    {
      type: 'tool_use',
      tool: { name: 'Bash', args: { command: 'ls' }, callId: 'call-1' },
      nativeId: 'u-call',
    },
    {
      type: 'tool_result',
      toolResult: { name: 'Bash', callId: 'call-1', result: BIG },
      nativeId: 'u-result',
    },
    { type: 'assistant', content: 'the answer', nativeId: 'u-1' },
    { type: 'result', sessionId: 'S1', raw: { type: 'result' } },
  ]);
  await daemon.spawnChat({ folder, chatId: 'dc' });
  await daemon.sendInput({ chatId: 'dc', message: 'question', localId: 'L1' });
  await new Promise((r) => setTimeout(r, 30));
  return { daemon, events, home };
}

describe('a turn on the host', () => {
  it('sends its start and its end, with outcome, through the outbox around its entries', async () => {
    const { daemon, events } = await runOneTurn();
    daemon.shutdown();
    const outboxed = events.filter((e) => isOutboxEvent(e) && e.chatId === 'dc');
    const kinds = outboxed.map((e) =>
      e.type === 'chat.message' ? `message:${e.role}` : e.type.replace('chat.', ''),
    );
    expect(kinds[0]).toBe('turn_started');
    expect(kinds[kinds.length - 1]).toBe('turn_ended');
    expect(kinds).toContain('message:user');
    expect(kinds).toContain('message:assistant');
    const start = outboxed[0] as Extract<WireEvent, { type: 'chat.turn_started' }>;
    const end = outboxed[outboxed.length - 1] as Extract<WireEvent, { type: 'chat.turn_ended' }>;
    expect(start).toMatchObject({ chatId: 'dc', harness: 'claude', origin: 'user' });
    expect(end).toMatchObject({ chatId: 'dc', turnId: start.turnId, outcome: 'completed' });
    // The end sits at the chat's highest seq: after every entry of the turn.
    const seqs = outboxed
      .filter((e) => e.type !== 'chat.turn_started' && e.type !== 'chat.turn_ended')
      .map((e) => (e as { seq: number }).seq);
    expect(end.seq).toBeGreaterThanOrEqual(Math.max(...seqs));
  });

  it("sends each entry with the provider's own id for it", async () => {
    const { daemon, events } = await runOneTurn();
    daemon.shutdown();
    const reply = events.find((e) => e.type === 'chat.message' && e.role === 'assistant');
    expect(reply).toMatchObject({ nativeRef: { harness: 'claude', sessionId: 'S1', id: 'u-1' } });
    const call = events.find((e) => e.type === 'chat.tool_call');
    expect(call).toMatchObject({ nativeRef: { id: 'u-call' } });
  });

  it('gives the import the same record, every tool result whole', async () => {
    const { daemon, events } = await runOneTurn();
    const record = daemon.recordForImport('dc');
    daemon.shutdown();
    const live = events.filter((e) => isOutboxEvent(e) && e.chatId === 'dc');
    const key = (e: WireEvent) =>
      `${e.type}:${(e as { seq: number }).seq}:${(e as { turnId?: string }).turnId ?? ''}`;
    expect(record.map(key)).toEqual(live.map(key));
    const result = record.find((e) => e.type === 'chat.tool_result');
    expect(result).toMatchObject({ result: BIG, nativeRef: { id: 'u-result' } });
    const reply = record.find((e) => e.type === 'chat.message' && e.role === 'assistant');
    expect(reply).toMatchObject({ nativeRef: { id: 'u-1' } });
  });
});

describe('a turn a restart finds open', () => {
  it('is closed as interrupted, and that end is sent too', () => {
    const home = tmp('record-complete-restart-');
    const first = makeLog(home);
    first.hydrate('c1', 0);
    first.beginTurn('c1', 't1');
    first.append(
      'c1',
      { k: 'turn.start', harness: 'claude', model: null, origin: 'user' },
      { branchId: 'c1-b0', sync: true },
    );
    first.closeAll();

    const second = makeLog(home);
    const written: LogRecord[] = [];
    second.onRecord((_chatId, record) => written.push(record));
    expect(second.hydrate('c1', 0).interruptedTurnId).toBe('t1');
    const boundaries = written.map((r) => turnBoundaryOf('c1', r));
    expect(boundaries).toEqual([
      expect.objectContaining({ type: 'chat.turn_ended', turnId: 't1', outcome: 'interrupted' }),
    ]);
  });
});

describe('recordEntries', () => {
  it('turns a log into what the record takes: entries, boundaries and settled questions', () => {
    const home = tmp('record-entries-');
    const log = makeLog(home);
    log.hydrate('c1', 0);
    log.beginTurn('c1', 't1');
    log.append(
      'c1',
      { k: 'turn.start', harness: 'claude', model: 'm', origin: 'user', sessionId: 'S1' },
      { branchId: 'c1-b0' },
    );
    const ref = { harness: 'claude' as const, sessionId: 'S1', id: 'u-r' };
    const seq0 = log.allocate('c1', 0, 'c1-b0');
    log.append(
      'c1',
      {
        k: 'event',
        event: {
          type: 'chat.tool_result',
          chatId: 'c1',
          tool: 'Bash',
          callId: 'x',
          result: BIG,
          seq: seq0,
        },
      },
      { branchId: 'c1-b0', seq: seq0, nativeRef: ref },
    );
    const q = log.allocate('c1', 0, 'c1-b0');
    log.append(
      'c1',
      {
        k: 'permission.request',
        requestId: 'q1',
        tool: 'AskUserQuestion',
        args: { questions: [] },
      },
      { branchId: 'c1-b0', seq: q },
    );
    log.append(
      'c1',
      {
        k: 'permission.decision',
        requestId: 'q1',
        decision: 'approve_with_edits',
        by: 'user',
        editedInput: { answers: { Which: 'A' } },
      },
      { branchId: 'c1-b0' },
    );
    // A permission that is not a question is not history.
    log.append(
      'c1',
      { k: 'permission.request', requestId: 'p1', tool: 'Bash', args: {} },
      { branchId: 'c1-b0', seq: log.allocate('c1', 0, 'c1-b0') },
    );
    log.append(
      'c1',
      { k: 'turn.end', outcome: 'failed', error: { code: 'sdk_error', message: 'boom' } },
      {
        branchId: 'c1-b0',
      },
    );
    log.endTurn('c1');

    const records = log.read('c1');
    // Stored as a reference on the host; sent whole.
    const stored = records.find((r) => r.rec.k === 'event')!.rec as { event: { result: unknown } };
    expect(stored.event.result).toHaveProperty('$blob');
    const entries = recordEntries('c1', records, { rehydrate: (r) => log.rehydrate(r) });
    expect(entries.map((e) => e.type)).toEqual([
      'chat.turn_started',
      'chat.tool_result',
      'chat.permission_request',
      'chat.permission_response',
      'chat.turn_ended',
    ]);
    expect(entries[0]).toMatchObject({ turnId: 't1', seq: -1, model: 'm', sessionId: 'S1' });
    expect(entries[1]).toMatchObject({ result: BIG, nativeRef: ref });
    expect(entries[3]).toMatchObject({ requestId: 'q1', approve: true, answers: { Which: 'A' } });
    expect(entries[4]).toMatchObject({
      turnId: 't1',
      outcome: 'failed',
      error: { code: 'sdk_error', message: 'boom' },
    });
  });

  it('sends a result whose stored body is missing as the reference it is, and says so', () => {
    const unreadable: number[] = [];
    const record: LogRecord = {
      v: 1,
      seq: 3,
      at: 1,
      branchId: 'c1-b0',
      rec: {
        k: 'event',
        event: {
          type: 'chat.tool_result',
          chatId: 'c1',
          tool: 'Bash',
          callId: 'x',
          result: { $blob: 'a'.repeat(64), bytes: 9, preview: 'p' },
          seq: 3,
        },
      },
    };
    const entries = recordEntries('c1', [record], {
      rehydrate: () => {
        throw new Error('ENOENT');
      },
      onUnreadable: (seq) => unreadable.push(seq),
    });
    expect(entries[0]).toMatchObject({ result: { $blob: 'a'.repeat(64) } });
    expect(unreadable).toEqual([3]);
  });
});
