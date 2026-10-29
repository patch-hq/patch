// WHOSE WORDS A FAILURE IS REPORTED IN (spec/12 § A turn only dies for a reason
// someone chose).
//
// Claude Code states a usage limit twice on the same message: as typed fields
// (`error`, `quotaLimits`) and as a sentence ("You've hit your monthly spend
// limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your
// weekly limit resets Sep 15, 4am (UTC)"). Patch has its own structured account
// of exactly that failure, so the sentence must not ALSO reach the reader — and
// the decision to replace it is taken off the fields, never off the wording.

import { describe, it, expect } from 'vitest';
import { limitFailureMessage, statedLimitOf } from '../src/limitFailure.js';
import { parseLimitResetsAt } from '../src/accountFailover.js';
import { limitFactsOf } from '../src/sdkBackend.js';

/** The real message, from the 7 Sep run that died on a spend limit. */
const SPEND_LIMIT_MESSAGE = {
  type: 'assistant',
  message: {
    model: '<synthetic>',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your weekly limit resets Sep 15, 4am (UTC)",
      },
    ],
    usage: { input_tokens: 0, output_tokens: 0 },
  },
  quotaLimits: {
    status: 'rejected',
    resetsAt: 1788804000,
    rateLimitType: 'seven_day',
  },
  error: 'rate_limit',
  isApiErrorMessage: true,
  apiErrorStatus: 429,
};

const PROVIDER_SENTENCE =
  "Claude Code returned an error result: You've hit your monthly spend limit · " +
  'raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your weekly ' +
  'limit resets Sep 15, 4am (UTC)';

describe('statedLimitOf — the structured fields decide, not the sentence', () => {
  it('reads the provider’s own fields as a stated limit', () => {
    const stated = statedLimitOf(limitFactsOf(SPEND_LIMIT_MESSAGE), PROVIDER_SENTENCE);
    expect(stated?.from).toBe('structured');
    expect(stated?.facts.rateLimitType).toBe('seven_day');
    expect(stated?.facts.resetsAt).toBe(1788804000_000);
  });

  it('takes a rejected window as a limit even with no typed kind', () => {
    expect(statedLimitOf({ status: 'rejected' }, 'anything at all')?.from).toBe('structured');
  });

  it('takes a block that says the account is fine as an answer, not a gap', () => {
    // The prose behind it is not consulted: a structured "allowed" plus a
    // sentence that reads like a limit is the provider contradicting itself,
    // and the field is the half that is host-stated.
    expect(statedLimitOf({ status: 'allowed' }, PROVIDER_SENTENCE)).toBeUndefined();
  });

  it('does not read an allowed block as a limit just because it names a window and reset', () => {
    for (const status of ['allowed', 'allowed_warning']) {
      const facts = { status, rateLimitType: 'seven_day', resetsAt: 1788804000_000 };
      expect(statedLimitOf(facts, 'Claude Code process exited with code 1')).toBeUndefined();
    }
  });

  it('does not read an unrelated typed failure as a limit', () => {
    expect(statedLimitOf({ kind: 'api_error' }, 'API Error: 500 internal')).toBeUndefined();
  });

  it('reads nothing out of the sentence when the provider stated no fields', () => {
    expect(statedLimitOf(undefined, PROVIDER_SENTENCE)).toBeUndefined();
  });

  it('is not a 529, which nobody reached a limit for', () => {
    expect(statedLimitOf(undefined, 'API Error: 529 overloaded_error')).toBeUndefined();
  });

  it('is not an ordinary crash, which keeps its real message', () => {
    expect(statedLimitOf(undefined, 'Error: socket hang up')).toBeUndefined();
    expect(statedLimitOf(undefined, 'TypeError: x is not a function')).toBeUndefined();
  });
});

describe('limitFailureMessage — patch’s own account of it', () => {
  const stated = statedLimitOf(limitFactsOf(SPEND_LIMIT_MESSAGE), PROVIDER_SENTENCE)!;

  it('says which window, on which account, and when it lifts', () => {
    const msg = limitFailureMessage(stated, { accountLabel: 'Default' });
    expect(msg).toContain('Default');
    expect(msg).toContain('weekly window');
    // An exact instant with its zone spelled out — never a wall-clock hour in
    // a zone the reader is not in.
    expect(msg).toContain('2026-09-07T18:00:00Z');
  });

  it('carries none of the provider’s sentence', () => {
    const msg = limitFailureMessage(stated, { accountLabel: 'Default' });
    expect(msg).not.toMatch(/spend limit/i);
    expect(msg).not.toMatch(/claude\.ai/i);
    expect(msg).not.toMatch(/cc_cli_limit_message/);
    expect(msg).not.toMatch(/raise it/i);
  });

  it('names the session window when that is the one that ran out', () => {
    const five = statedLimitOf({ kind: 'rate_limit', rateLimitType: 'five_hour' }, '')!;
    expect(limitFailureMessage(five)).toContain('session window');
  });

  it('claims no window and no reset it was not told', () => {
    const bare = statedLimitOf({ kind: 'rate_limit' }, '')!;
    const msg = limitFailureMessage(bare);
    expect(msg).toMatch(/no reset time/i);
    expect(msg).not.toMatch(/window/);
  });

  it('states its reset in a form the restart re-arm reads back', () => {
    // After a restart the only record of a limit is the chat's stored
    // `lastError` sentence, and what is recovered from it is the instant to
    // re-arm the retry at. Patch's own sentence has to give that up as
    // readily as the provider's did.
    const msg = limitFailureMessage(stated, { accountLabel: 'Default' });
    expect(parseLimitResetsAt(msg, 1_700_000_000_000)).toBe(1788804000_000);
  });
});
