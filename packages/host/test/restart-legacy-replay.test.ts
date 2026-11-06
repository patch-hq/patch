import { describe, expect, it } from 'vitest';
import { restartResendAsOwnMessage } from '../src/chatRunner.js';

const LEGACY = 'Host restarted — the running turn was cut off and has been re-sent';

describe('replay of a chat written when restarts folded as retries', () => {
  it('rewrites the legacy marker and unfolds the re-send that follows it', () => {
    const state = { afterMarker: false };
    const marker = restartResendAsOwnMessage(
      { type: 'chat.message', role: 'system', content: LEGACY, seq: 3 },
      state,
    );
    expect((marker as { content: string }).content).toBe('Turn interrupted by restart');
    const resend = restartResendAsOwnMessage(
      { type: 'chat.message', role: 'user', content: 'Carry on', seq: 4, retryOfSeq: 2 },
      state,
    );
    expect(resend).toEqual({ type: 'chat.message', role: 'user', content: 'Carry on', seq: 4 });
  });

  it('keeps a person-chosen retry folded', () => {
    const state = { afterMarker: false };
    const retry = { type: 'chat.message', role: 'user', content: 'x', seq: 9, retryOfSeq: 2 };
    expect(restartResendAsOwnMessage(retry, state)).toBe(retry);
  });

  it('only unfolds the first user message after a marker', () => {
    const state = { afterMarker: false };
    restartResendAsOwnMessage(
      { type: 'chat.message', role: 'system', content: LEGACY, seq: 3 },
      state,
    );
    restartResendAsOwnMessage({ type: 'chat.message', role: 'user', content: 'a', seq: 4 }, state);
    const later = { type: 'chat.message', role: 'user', content: 'b', seq: 8, retryOfSeq: 5 };
    expect(restartResendAsOwnMessage(later, state)).toBe(later);
  });
});
