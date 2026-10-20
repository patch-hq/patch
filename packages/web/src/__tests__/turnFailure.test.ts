import { describe, expect, it } from 'vitest';
import { classifyTurnFailure } from '../lib/turnFailure';

describe('classifyTurnFailure', () => {
  it('flags context overflow as permanent', () => {
    const r = classifyTurnFailure(
      '400 context_length_exceeded: Your input exceeds the context window of this model. Please adjust your input and try again.',
    );
    expect(r?.kind).toBe('context_length');
    expect(r?.permanent).toBe(true);
    expect(r?.headline).toMatch(/too large/);
    expect(r?.headline).toMatch(/fail again/);
  });
  it.each([
    ['429 rate_limit_exceeded', 'rate_limit'],
    ['HTTP 401 invalid_api_key', 'auth'],
    ['fetch failed: ECONNRESET', 'network'],
    ['something odd', 'unknown'],
  ])('%s -> %s, retryable', (msg, kind) => {
    const r = classifyTurnFailure(msg);
    expect(r?.kind).toBe(kind);
    expect(r?.permanent).toBe(false);
  });
  it('returns undefined without a message', () => {
    expect(classifyTurnFailure(undefined)).toBeUndefined();
  });
});
