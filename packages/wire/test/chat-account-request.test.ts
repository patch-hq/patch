import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/codec.js';
import { ChatAccountRequestEvent, ChatStateEvent } from '../src/events.js';
import { WireDecodeError } from '../src/errors.js';

describe('chat.account_request', () => {
  it('round-trips an account and a null (by strategy)', () => {
    for (const id of ['a2', null]) {
      const ev: ChatAccountRequestEvent = {
        type: 'chat.account_request',
        chatId: 'c1',
        preferredAccountId: id,
      };
      expect(decode(encode(ev))).toEqual(ev);
    }
  });
  it('requires the field and rejects an empty id and unknown fields', () => {
    const base = { type: 'chat.account_request', chatId: 'c1' };
    expect(ChatAccountRequestEvent.safeParse(base).success).toBe(false);
    expect(ChatAccountRequestEvent.safeParse({ ...base, preferredAccountId: '' }).success).toBe(
      false,
    );
    expect(() => decode(JSON.stringify({ ...base, preferredAccountId: 'a', extra: 1 }))).toThrow(
      WireDecodeError,
    );
  });
  it('chat.state carries preferredAccountId, null or absent', () => {
    const base = {
      type: 'chat.state' as const,
      chatId: 'c1',
      activity: 'idle' as const,
      lastUpdated: 1,
      permissionMode: 'auto' as const,
    };
    for (const extra of [{ preferredAccountId: 'a2' }, { preferredAccountId: null }, {}]) {
      const ev: ChatStateEvent = { ...base, ...extra };
      expect(decode(encode(ev))).toEqual(ev);
    }
  });
});
