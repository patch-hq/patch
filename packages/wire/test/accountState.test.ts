import { describe, expect, it } from 'vitest';
import { deriveAccountState, accountStateRunnable } from '../src/index.js';

const NOW = 1_000_000;
const win = (over: object = {}) => ({ status: 'allowed' as const, ...over });

describe('deriveAccountState (spec/10 § Account states)', () => {
  it('is ready with no reading: unknown usage is not a limit', () => {
    expect(deriveAccountState({ hasCredential: true }, NOW)).toEqual({ state: 'ready' });
  });

  it('is signed out with no credential or a refused one, outranking everything', () => {
    const refusal = { kind: 'out' as const, message: 'x', at: NOW };
    expect(deriveAccountState({ hasCredential: false, refusal }, NOW)).toEqual({
      state: 'signed_out',
    });
    expect(
      deriveAccountState({ hasCredential: true, credentialRefused: true, refusal }, NOW),
    ).toEqual({
      state: 'signed_out',
    });
  });

  it('is out on a billing refusal, in the provider words', () => {
    expect(
      deriveAccountState(
        {
          hasCredential: true,
          refusal: { kind: 'out', message: 'credit balance is too low', at: NOW },
        },
        NOW,
      ),
    ).toEqual({ state: 'out', message: 'credit balance is too low' });
  });

  it('is broken on a failed renewal or a reported fault, in the provider words', () => {
    expect(deriveAccountState({ hasCredential: true, renewalError: 'HTTP 500' }, NOW)).toEqual({
      state: 'broken',
      message: 'HTTP 500',
    });
    expect(deriveAccountState({ hasCredential: true, error: 'login type changed' }, NOW)).toEqual({
      state: 'broken',
      message: 'login type changed',
    });
  });

  it('is limited until the stated reset; a pool at 98% of a future reset counts', () => {
    expect(
      deriveAccountState(
        { hasCredential: true, usage: { session: win({ status: 'rejected', resetsAt: NOW + 5 }) } },
        NOW,
      ),
    ).toEqual({ state: 'limited', until: NOW + 5 });
    expect(
      deriveAccountState(
        { hasCredential: true, usage: { week: win({ utilization: 0.98, resetsAt: NOW + 9 }) } },
        NOW,
      ),
    ).toEqual({ state: 'limited', until: NOW + 9 });
  });

  it('a limit with no stated reset holds until a later reading shows credit', () => {
    const refusal = { kind: 'limit' as const, message: 'limit', at: NOW };
    expect(deriveAccountState({ hasCredential: true, refusal }, NOW + 1)).toEqual({
      state: 'limited',
    });
    expect(
      deriveAccountState(
        { hasCredential: true, refusal, usage: { at: NOW - 1, session: win() } },
        NOW + 1,
      ),
    ).toEqual({ state: 'limited' });
    expect(
      deriveAccountState(
        { hasCredential: true, refusal, usage: { at: NOW + 1, session: win() } },
        NOW + 2,
      ),
    ).toEqual({ state: 'ready' });
  });

  it('a stated reset that has passed no longer limits', () => {
    const refusal = { kind: 'limit' as const, until: NOW - 1, message: 'limit', at: NOW - 100 };
    expect(deriveAccountState({ hasCredential: true, refusal }, NOW)).toEqual({ state: 'ready' });
  });

  it('is near limit past the warning level or with a run-out estimate; overage alone is ready', () => {
    expect(
      deriveAccountState(
        { hasCredential: true, usage: { session: win({ status: 'allowed_warning' }) } },
        NOW,
      ),
    ).toEqual({ state: 'near_limit' });
    expect(
      deriveAccountState(
        { hasCredential: true, usage: { week: win({ runsOutAt: NOW + 10 }) } },
        NOW,
      ),
    ).toEqual({ state: 'near_limit' });
    expect(
      deriveAccountState(
        { hasCredential: true, usage: { overage: win({ status: 'rejected' }) } },
        NOW,
      ),
    ).toEqual({ state: 'ready' });
  });

  it('only ready and near limit can run a turn', () => {
    expect(accountStateRunnable({ state: 'near_limit' })).toBe(true);
    expect(accountStateRunnable({ state: 'limited' })).toBe(false);
    expect(accountStateRunnable({ state: 'signed_out' })).toBe(false);
  });
});
