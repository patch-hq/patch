import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallEndOutbox, CALL_END_RETRY_MS } from '../src/call-end.js';
import type { VoiceEndCallRequestEvent } from '../src/events.js';

describe('CallEndOutbox', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the end at once and holds it until the server answers', () => {
    const sent: VoiceEndCallRequestEvent[] = [];
    const box = new CallEndOutbox({ send: (e) => sent.push(e) });
    box.end('c1', 's1');
    expect(sent).toEqual([
      { type: 'voice.end_call_request', chatId: 'c1', sessionId: 's1', requestId: 'end-s1' },
    ]);
    vi.advanceTimersByTime(CALL_END_RETRY_MS);
    expect(sent).toHaveLength(2);
    box.answered('end-s1');
    vi.advanceTimersByTime(CALL_END_RETRY_MS * 3);
    expect(sent).toHaveLength(2);
    expect(box.size()).toBe(0);
  });

  it('with the server channel down, holds the end and sends it when the link is back', () => {
    const sent: VoiceEndCallRequestEvent[] = [];
    let up = false;
    const box = new CallEndOutbox({
      send: (e) => {
        if (!up) throw new Error('not connected');
        sent.push(e);
      },
    });
    box.end('c1', 's1');
    expect(sent).toEqual([]);
    expect(box.size()).toBe(1);
    up = true;
    box.onReconnect();
    expect(sent).toHaveLength(1);
    box.answered('end-s1');
    expect(box.size()).toBe(0);
  });

  it('ending the same call twice is one request', () => {
    const sent: VoiceEndCallRequestEvent[] = [];
    const box = new CallEndOutbox({ send: (e) => sent.push(e) });
    box.end('c1', 's1');
    box.end('c1', 's1');
    expect(sent).toHaveLength(1);
    box.reset();
  });
});
