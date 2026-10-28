// One provider-generic "account out of credit" signal: each backend maps its
// own typed data into LimitFacts, and the failure carries it.
import { describe, it, expect } from 'vitest';
import {
  createLimitEventMemory,
  mergeRejectedLimit,
  rejectedLimitOfEvent,
  TurnFailedError,
} from '../src/sdkBackend.js';
import { codexLimitOf } from '../src/codexBackend.js';
import { isAccountExhausted } from '../src/accountFailover.js';

const rejectedEvent = {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1788804000 },
};
const failingAssistant = {
  type: 'assistant',
  error: 'rate_limit',
  message: { content: [{ type: 'text', text: "You've hit your session limit" }] },
};

describe('rate_limit_event attached to the failing turn', () => {
  it('reads only a rejected event, resetsAt normalised to ms', () => {
    expect(rejectedLimitOfEvent(rejectedEvent)).toEqual({
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: 1788804000_000,
    });
    expect(
      rejectedLimitOfEvent({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' },
      }),
    ).toBeUndefined();
  });

  it('the failure carries the earlier event, so the failure is exhausted without any phrase', () => {
    const mem = createLimitEventMemory();
    mem.note(rejectedEvent);
    let thrown: unknown;
    try {
      mem.assertNotAnError(failingAssistant);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TurnFailedError);
    const limit = (thrown as TurnFailedError).limit;
    expect(limit).toMatchObject({
      kind: 'rate_limit',
      status: 'rejected',
      rateLimitType: 'five_hour',
    });
    // wording the phrase list has never heard of
    expect(isAccountExhausted(limit)).toBe(true);
  });

  it('ignores a rejected event for a different window than the failure names', () => {
    // 28 Oct: "session limit · resets 7pm" arrived after a rejected seven_day
    // event; the weekly reset (a Tuesday) was shown as when the account returns.
    const mem = createLimitEventMemory();
    mem.note({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1788804000 },
    });
    let thrown: unknown;
    try {
      mem.assertNotAnError({
        type: 'assistant',
        error: 'rate_limit',
        message: {
          content: [
            { type: 'text', text: "You've hit your session limit · resets 7pm (Europe/London)" },
          ],
        },
      });
    } catch (e) {
      thrown = e;
    }
    const limit = (thrown as TurnFailedError).limit;
    expect(limit?.resetsAt).toBeUndefined();
    expect(limit?.status).toBeUndefined();
    expect(isAccountExhausted(limit)).toBe(false);
  });

  it('does not override a status the failure itself states', () => {
    expect(mergeRejectedLimit({ status: 'allowed' }, { status: 'rejected' })?.status).toBe(
      'allowed',
    );
  });
});

describe('codex mapping', () => {
  it('maps its typed usage-limit code to the shared signal', () => {
    const limit = codexLimitOf({ message: 'x', codexErrorInfo: 'usageLimitExceeded' });
    expect(limit).toEqual({ kind: 'usage_limit_exceeded', status: 'rejected' });
    expect(isAccountExhausted(limit)).toBe(true);
    expect(codexLimitOf({ message: 'boom' })).toBeUndefined();
  });
});
