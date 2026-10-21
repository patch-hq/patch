import { describe, it, expect } from 'vitest';
import { describeTurnFailure, SLEPT_THROUGH_MESSAGE } from '../src/failureCopy.js';

const CRASH =
  'Claude Code returned an error result: [session_crash] error_name=AbortError api_error_status=none cause_name=none';

describe('describeTurnFailure', () => {
  it('says the machine slept, whatever the provider said', () => {
    expect(describeTurnFailure(CRASH, { sleptThrough: true })).toBe(SLEPT_THROUGH_MESSAGE);
  });

  it('names a session crash by its error, not its field dump', () => {
    expect(describeTurnFailure(CRASH, { sleptThrough: false })).toBe(
      "Claude Code's session crashed before the turn finished (AbortError).",
    );
  });

  it('leaves every other message as the provider wrote it', () => {
    const limit = "You've hit your monthly spend limit · resets 8pm (UTC)";
    expect(describeTurnFailure(limit, { sleptThrough: false })).toBe(limit);
  });
});
