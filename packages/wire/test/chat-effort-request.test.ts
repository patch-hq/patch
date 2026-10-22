import { describe, expect, it } from 'vitest';

import { decode, encode } from '../src/codec.js';
import { ChatEffortRequestEvent, ChatStateEvent } from '../src/events.js';
import { WireDecodeError } from '../src/errors.js';

// spec/04 § Effort — Claude's thinking-effort override is changeable mid-chat.
// Two halves ride the wire: the surface's `chat.effort_request`, and the
// daemon's acknowledgement, which is the `effort` it now carries on every
// `chat.state`.

describe('chat.effort_request', () => {
  it('round-trips a level through the codec', () => {
    const ev: ChatEffortRequestEvent = {
      type: 'chat.effort_request',
      chatId: 'c1',
      effort: 'high',
    };
    expect(decode(encode(ev))).toEqual(ev);
  });

  it('round-trips effort: null — unlike chat.model_request, there IS a clear meaning', () => {
    const ev: ChatEffortRequestEvent = {
      type: 'chat.effort_request',
      chatId: 'c1',
      effort: null,
    };
    expect(decode(encode(ev))).toEqual(ev);
  });

  it('requires the field — absence is not accepted as a stand-in for null', () => {
    expect(
      ChatEffortRequestEvent.safeParse({ type: 'chat.effort_request', chatId: 'c1' }).success,
    ).toBe(false);
  });

  it('rejects a level outside the SDK set', () => {
    expect(
      ChatEffortRequestEvent.safeParse({
        type: 'chat.effort_request',
        chatId: 'c1',
        effort: 'extreme',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown field rather than dropping it', () => {
    expect(() =>
      decode(
        JSON.stringify({
          type: 'chat.effort_request',
          chatId: 'c1',
          effort: 'high',
          applyToRunningTurn: true,
        }),
      ),
    ).toThrow(WireDecodeError);
  });
});

describe('chat.state carries the chat effort', () => {
  const base = {
    type: 'chat.state' as const,
    chatId: 'c1',
    activity: 'idle' as const,
    lastUpdated: 1,
    permissionMode: 'auto' as const,
  };

  it('accepts a level and round-trips it', () => {
    const ev: ChatStateEvent = { ...base, effort: 'high' };
    const decoded = decode(encode(ev));
    expect(decoded.type === 'chat.state' && decoded.effort).toBe('high');
  });

  it('accepts and round-trips an explicit null (no override set)', () => {
    const ev: ChatStateEvent = { ...base, effort: null };
    const decoded = decode(encode(ev));
    expect(decoded.type === 'chat.state' && decoded.effort).toBeNull();
  });

  it('still accepts a frame with no effort field at all — "unchanged", not "none"', () => {
    const parsed = ChatStateEvent.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.effort).toBeUndefined();
  });

  it('rejects a level outside the SDK set', () => {
    expect(ChatStateEvent.safeParse({ ...base, effort: 'extreme' }).success).toBe(false);
  });
});
