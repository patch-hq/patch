// A reattached turn whose `result` was already handled by the previous host
// skipped it, so the consumer saw a stream with no final result and retried a
// turn that had finished (issue #686).
import { describe, it, expect } from 'vitest';
import { handledResultToReplay } from '../src/sdkBackend.js';

describe('handledResultToReplay', () => {
  const result = { type: 'result' as const, sessionId: 'S', content: 'done' };
  it('replays a result the previous host handled', () => {
    expect(handledResultToReplay([result], -1)).toEqual({ type: 'result', sessionId: 'S' });
    expect(handledResultToReplay([result], 1)).toEqual({ type: 'result', sessionId: 'S' });
  });
  it('leaves a result that is being delivered normally', () => {
    expect(handledResultToReplay([result], 0)).toBeUndefined();
  });
  it('ignores messages with no result', () => {
    expect(handledResultToReplay([{ type: 'assistant', content: 'x' }], -1)).toBeUndefined();
  });
});
