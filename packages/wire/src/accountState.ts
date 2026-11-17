// One state per account (spec/10 § Account states).
//
// An account is exactly one of ready, near limit, limited until a reset, out,
// signed out or broken. The server derives it, once, from the facts below and
// sends the result; a surface displays what it is sent and never works it out
// from usage figures of its own. The derivation lives here, beside the shape,
// so the server and its tests share one definition of every rule.

import { z } from 'zod';
import {
  RATE_LIMIT_WARN_UTILIZATION,
  refusingRateLimitScope,
  type RateLimitWindows,
} from './usageWindows.js';

export const AccountState = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready') }).strict(),
  /** Usable, but a pool is past its warning level or estimated to run out soon. */
  z.object({ state: z.literal('near_limit') }).strict(),
  /** A temporary limit. `until` (ms-epoch) is absent when the provider states no reset. */
  z.object({ state: z.literal('limited'), until: z.number().optional() }).strict(),
  /** Billing or credit that needs the user. Never retried. */
  z.object({ state: z.literal('out'), message: z.string().min(1) }).strict(),
  /** The credential is absent, expired or refused. Never retried. */
  z.object({ state: z.literal('signed_out') }).strict(),
  /** Anything else wrong with the account, in the provider's words. */
  z.object({ state: z.literal('broken'), message: z.string().min(1) }).strict(),
]);
export type AccountState = z.infer<typeof AccountState>;
export type AccountStateName = AccountState['state'];

/** What a provider refused a turn or call with, as an adapter reports it. */
export const AccountRefusal = z
  .object({
    /** `limit` clears on its own; `out` is billing or credit and needs the user. */
    kind: z.enum(['limit', 'out']),
    /** When a `limit` clears (ms-epoch), where the provider stated it. */
    until: z.number().optional(),
    /** The provider's own words. */
    message: z.string().min(1),
    /** When the refusal happened (ms-epoch). */
    at: z.number(),
  })
  .strict();
export type AccountRefusal = z.infer<typeof AccountRefusal>;

export interface AccountStateFacts {
  /** The server holds a credential for this account. */
  hasCredential: boolean;
  /** The server's own renewal of the credential failed, in the provider's words. */
  renewalError?: string | undefined;
  /** A provider call refused the credential as expired or revoked. */
  credentialRefused?: boolean | undefined;
  /** Something else wrong the adapter reported, in the provider's words. */
  error?: string | undefined;
  refusal?: AccountRefusal | undefined;
  /** The freshest usage reading. An API key has none. */
  usage?: (RateLimitWindows & { at?: number | undefined }) | undefined;
}

/**
 * The one state of an account, from the provider's own signals.
 *
 * Order matters and is the spec's: a missing or refused credential outranks
 * everything (nothing else about the account can be known), then money, then
 * faults, then limits, then the warning.
 *
 * Unknown usage is neither credit nor a limit: an account with no reading is
 * ready. A reading shows credit only when taken after the refusal it would
 * lift, so one taken seconds before a refusal cannot undo it.
 */
export function deriveAccountState(
  facts: AccountStateFacts,
  now: number = Date.now(),
): AccountState {
  if (!facts.hasCredential || facts.credentialRefused === true) return { state: 'signed_out' };
  const { refusal, usage } = facts;
  if (refusal?.kind === 'out') return { state: 'out', message: refusal.message };
  if (facts.renewalError) return { state: 'broken', message: facts.renewalError };
  if (facts.error) return { state: 'broken', message: facts.error };

  const scope = refusingRateLimitScope(usage, now);
  if (scope !== undefined) {
    const resetsAt = usage?.[scope]?.resetsAt;
    return resetsAt !== undefined ? { state: 'limited', until: resetsAt } : { state: 'limited' };
  }
  if (refusal?.kind === 'limit') {
    const stillRefused =
      refusal.until !== undefined
        ? refusal.until > now
        : usage?.at === undefined || usage.at <= refusal.at;
    if (stillRefused) {
      return refusal.until !== undefined
        ? { state: 'limited', until: refusal.until }
        : { state: 'limited' };
    }
  }
  if (usage) {
    for (const key of ['session', 'week'] as const) {
      const w = usage[key];
      if (!w) continue;
      const warned =
        w.status === 'allowed_warning' || (w.utilization ?? 0) >= RATE_LIMIT_WARN_UTILIZATION;
      if (warned || (w.runsOutAt !== undefined && w.runsOutAt > now))
        return { state: 'near_limit' };
    }
  }
  return { state: 'ready' };
}

/** The same words on every surface. A reset time is formatted by the surface, in its own zone. */
export const ACCOUNT_STATE_LABEL: Record<AccountStateName, string> = {
  ready: 'Ready',
  near_limit: 'Near limit',
  limited: 'Limited',
  out: 'Out of credit',
  signed_out: 'Signed out',
  broken: 'Broken',
};

/** Can a turn run on this account? `limited`, `out` and `signed_out` and `broken` cannot. */
export function accountStateRunnable(state: AccountState): boolean {
  return state.state === 'ready' || state.state === 'near_limit';
}

export function accountStatesEqual(a: AccountState, b: AccountState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The words for a state, the same on every surface. The reset instant is
 * formatted by the caller, in the reader's own zone.
 */
export function describeAccountState(
  state: AccountState,
  formatTime: (at: number) => string,
): string {
  switch (state.state) {
    case 'limited':
      return state.until !== undefined
        ? `${ACCOUNT_STATE_LABEL.limited} until ${formatTime(state.until)}`
        : `${ACCOUNT_STATE_LABEL.limited}, no reset stated`;
    case 'out':
    case 'broken':
      return `${ACCOUNT_STATE_LABEL[state.state]}: ${state.message}`;
    default:
      return ACCOUNT_STATE_LABEL[state.state];
  }
}
