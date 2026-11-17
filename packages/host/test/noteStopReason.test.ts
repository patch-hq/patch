import { describe, expect, it } from 'vitest';
import { noteStopReason } from '../src/sdkBackend.js';

const delta = (stop_reason: string) => ({
  type: 'stream_event',
  event: { type: 'message_delta', delta: { stop_reason } },
});
const assistant = (stop_reason: string | null) => ({
  type: 'assistant',
  message: { stop_reason, content: [] },
});

describe('noteStopReason', () => {
  it('reads the stop reason from message_delta, where streamed turns carry it', () => {
    let r: string | undefined;
    r = noteStopReason({ type: 'stream_event', event: { type: 'message_start' } }, r);
    r = noteStopReason(assistant(null), r);
    r = noteStopReason(delta('end_turn'), r);
    r = noteStopReason({ type: 'stream_event', event: { type: 'message_stop' } }, r);
    r = noteStopReason({ type: 'system', subtype: 'status' }, r);
    expect(r).toBe('end_turn');
  });

  it('clears on a new message so an earlier end does not carry into the next one', () => {
    let r: string | undefined = noteStopReason(delta('end_turn'), undefined);
    r = noteStopReason({ type: 'stream_event', event: { type: 'message_start' } }, r);
    r = noteStopReason(assistant(null), r);
    expect(r).toBeUndefined();
  });

  it('clears on a user message (tool results, new input)', () => {
    expect(noteStopReason({ type: 'user' }, 'end_turn')).toBeUndefined();
  });

  it('still reads a stop reason set on the assistant message itself', () => {
    expect(noteStopReason(assistant('tool_use'), undefined)).toBe('tool_use');
  });
});
