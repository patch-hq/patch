import { describe, expect, it } from 'vitest';

import { decode, encode } from '../src/codec.js';
import { PatchActivityRequestEvent, PatchActivityResponseEvent } from '../src/events.js';

// spec/06 § `patch_activity` — dwell sessions are an opt-in extension of the
// messages-only request/response, so the messages-only frames an older host
// sends and parses stay valid byte for byte.

describe('patch.activity dwell sessions', () => {
  it('a messages-only request and response still decode', () => {
    const req = { type: 'patch.activity.request', sourceChatId: 'c1', since: 1, until: 2 };
    const res = {
      type: 'patch.activity.response',
      sourceChatId: 'c1',
      messages: [],
      messagesTruncated: false,
    };
    expect(PatchActivityRequestEvent.parse(req)).toEqual(req);
    expect(PatchActivityResponseEvent.parse(res)).toEqual(res);
  });

  it('round-trips a request that asks for sessions and a response that carries them', () => {
    const req: PatchActivityRequestEvent = {
      type: 'patch.activity.request',
      sourceChatId: 'c1',
      since: 1,
      until: 2,
      includeSessions: true,
      sessionsCursor: 1,
    };
    const res: PatchActivityResponseEvent = {
      type: 'patch.activity.response',
      sourceChatId: 'c1',
      messages: [],
      messagesTruncated: false,
      chatSessions: [
        {
          chatId: 'c2',
          chatName: null,
          hostId: 'h',
          folder: '/w',
          start: 1,
          end: 2,
          durationMs: 1,
        },
      ],
      sessionsTruncated: true,
      nextSessionsCursor: 2,
    };
    expect(decode(encode(req))).toEqual(req);
    expect(decode(encode(res))).toEqual(res);
  });

  it('rejects a negative sessions cursor', () => {
    expect(() =>
      PatchActivityRequestEvent.parse({
        type: 'patch.activity.request',
        sourceChatId: 'c1',
        since: 1,
        until: 2,
        sessionsCursor: -1,
      }),
    ).toThrow();
  });
});
