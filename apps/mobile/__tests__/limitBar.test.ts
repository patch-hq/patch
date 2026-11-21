// The mobile limit bar says what happens next for a paused chat, and offers
// Continue only where the user is the one who has to act (decision 25).
import { describe, expect, it } from 'vitest';
import { limitBarText } from '../src/components/chatBars/LimitBar';
import { creditPause } from '../src/lib/queueLabel';

describe('limitBarText', () => {
  it('offers Continue once credit is back', () => {
    expect(
      limitBarText({ creditReturned: true, limitNext: 'ask', resumeKind: 'rate_limit' }),
    ).toEqual({
      text: 'Credit available again',
      canContinue: true,
    });
  });
  it('offers Continue for out of credit and for a provider switch, not for a host-run resume', () => {
    expect(limitBarText({ limitNext: 'ask', resumeKind: 'rate_limit' })?.canContinue).toBe(true);
    expect(
      limitBarText({ limitNext: 'switch_provider', resumeKind: 'rate_limit' })?.canContinue,
    ).toBe(true);
    expect(
      limitBarText({ limitNext: 'resume_at_reset', resumeKind: 'rate_limit' })?.canContinue,
    ).toBe(false);
    expect(
      limitBarText({ limitNext: 'other_account', resumeKind: 'rate_limit' })?.canContinue,
    ).toBe(false);
  });
  it('says nothing for an overload or a chat with no pause', () => {
    expect(limitBarText({ limitNext: null, resumeKind: 'overloaded' })).toBeNull();
    expect(limitBarText({ limitNext: null, resumeKind: null })).toBeNull();
  });
});

describe('creditPause', () => {
  it('promises no resume time for a pause that waits on the user', () => {
    const row = {
      chatStatus: { state: 'paused', reason: 'session', resetsAt: 5_000 },
      limitNext: 'switch_provider' as const,
    };
    expect(creditPause(row)).toEqual({ kind: 'limit', scope: 'session', resetsAt: null });
    expect(creditPause({ ...row, limitNext: 'resume_at_reset' })).toEqual({
      kind: 'limit',
      scope: 'session',
      resetsAt: 5_000,
    });
  });
});
