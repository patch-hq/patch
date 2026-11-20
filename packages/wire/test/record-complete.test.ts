// What the server's whole record is sent (spec/01 § Chat record): turn
// boundaries and each entry's provider id.

import { describe, it, expect } from 'vitest';
import { decode, encode, isOutboxEvent, type WireEvent } from '../src/index.js';

const ref = { harness: 'claude', sessionId: 'S1', id: 'u-1' };

describe('the whole record on the wire', () => {
  it('a logged entry may carry its provider id', () => {
    const e = {
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'x',
      seq: 0,
      nativeRef: ref,
    };
    expect(decode(JSON.stringify(e))).toEqual(e);
  });

  it('a malformed provider id is refused', () => {
    const e = {
      type: 'chat.tool_call',
      chatId: 'c1',
      tool: 'Bash',
      args: {},
      callId: 'k',
      seq: 1,
      nativeRef: { id: 'u' },
    };
    expect(() => decode(JSON.stringify(e))).toThrow();
  });

  it('turn boundaries go through the outbox, from before the first entry on', () => {
    const start = {
      type: 'chat.turn_started',
      chatId: 'c1',
      turnId: 't',
      seq: -1,
      at: 1,
    } as WireEvent;
    const end = {
      type: 'chat.turn_ended',
      chatId: 'c1',
      turnId: 't',
      seq: 3,
      at: 2,
      outcome: 'completed',
    } as WireEvent;
    expect(decode(encode(start))).toEqual(start);
    expect(isOutboxEvent(start)).toBe(true);
    expect(isOutboxEvent(end)).toBe(true);
    // An entry still needs a seq of its own.
    expect(isOutboxEvent({ type: 'chat.message', chatId: 'c1', seq: -1 } as never)).toBe(false);
    expect(isOutboxEvent({ ...end, seq: -2 } as WireEvent)).toBe(false);
  });

  it('a tool-log entry goes through the outbox though it belongs to no chat', () => {
    const entry = {
      type: 'patch.tool_log.entry',
      entry: { ts: 1, tool: 'patch_peek', durationMs: 2, ok: true },
    } as WireEvent;
    expect(decode(encode(entry))).toEqual(entry);
    expect(isOutboxEvent(entry)).toBe(true);
  });

  it('a turn boundary is refused below -1 or with an outcome it does not know', () => {
    expect(() =>
      decode(
        JSON.stringify({ type: 'chat.turn_started', chatId: 'c1', turnId: 't', seq: -2, at: 1 }),
      ),
    ).toThrow();
    expect(() =>
      decode(
        JSON.stringify({
          type: 'chat.turn_ended',
          chatId: 'c1',
          turnId: 't',
          seq: 0,
          at: 1,
          outcome: 'done',
        }),
      ),
    ).toThrow();
  });
});
