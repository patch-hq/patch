// One-shot Claude calls on the host's accounts (spec/10 § Choosing an
// account): titles, status summaries, labels, the sweep. A one-shot has no
// next turn, so it walks the accounts itself and marks what it learns on the
// way, so the calls behind it skip a spent account rather than each
// rediscovering it.
//
// Only an ACCOUNT-EXHAUSTED failure moves to the next account. Anything else —
// a timeout, a malformed reply, the SDK falling over — would fail the same way
// on every account, and retrying it across all of them turns one failed call
// into N.

import type { ClaudeStoredAccount } from '@patch/auth';
import {
  isAccountExhausted,
  parseLimitResetsAt,
  type AccountRotation,
  type FailoverAccount,
  type RouteOptions,
} from './accountFailover.js';
import type { BedrockRun, LimitFacts } from './sdkBackend.js';
import { bedrockRunOf } from './bedrockAccounts.js';

type Resolved = { ok: true; accessToken: string } | { ok: false; reason: string };

export interface ClaudeOneShotDeps {
  /** The stored Claude accounts; null when there is no store (the mock backend in tests). */
  accounts: () => ClaudeStoredAccount[] | null;
  rotation: AccountRotation;
  /** The accounts as failover sees them and the route for one question; `preferred` locks it to one. */
  route: (preferred?: string) => { accounts: FailoverAccount[]; route: RouteOptions };
  /** A token account's credential (refreshing it when due). `undefined`: the store's default. */
  resolveOAuth: (accountId?: string) => Promise<Resolved>;
  /** A probe reading says the account is blocked. */
  probeBlocked: (accountId: string) => boolean;
  /** Something about the accounts' credit changed: tell the surfaces. */
  onMarked: () => void;
  logger: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
}

export type OneShotRun<T> = (accessToken: string, bedrock?: BedrockRun) => Promise<T>;

/**
 * Run `run` on the first account with credit that completes it: every account
 * in the order, or `only` that one account (the shared `backgroundAccount`).
 * Null when no account could answer; any other failure is rethrown with the
 * provider's words.
 */
export async function runClaudeOneShot<T>(
  deps: ClaudeOneShotDeps,
  label: string,
  run: OneShotRun<T>,
  only?: string,
): Promise<T | null> {
  const stored = deps.accounts();
  if (stored === null || stored.length === 0) {
    if (only !== undefined) {
      deps.logger.warn({ label, account: only }, 'ai call: the named account is not held here');
      return null;
    }
    const resolved = await deps.resolveOAuth();
    if (!resolved.ok) {
      deps.logger.warn({ label, reason: resolved.reason }, 'ai call: OAuth unavailable');
      return null;
    }
    return await run(resolved.accessToken);
  }
  if (only !== undefined && !stored.some((a) => a.id === only)) {
    // Naming an account is the call running there or nowhere (spec/10): a
    // title is left as it is rather than spent on an account nobody chose.
    deps.logger.warn(
      { label, account: only },
      'ai call: the account named for titles and status is not held on this host',
    );
    return null;
  }
  const { accounts, route } = deps.route(only);
  // A named account is that account alone, spent or not.
  const order = deps.rotation.usableAccounts(
    accounts,
    only !== undefined ? { ...route, resumeOnAnyAccount: false } : route,
  );
  if (order.length === 0) {
    deps.logger.warn(
      { label, sidelined: deps.rotation.snapshot() },
      'ai call: every account is out of credit',
    );
    return null;
  }
  for (const accountId of order) {
    const account = stored.find((a) => a.id === accountId);
    const bedrock = account !== undefined ? bedrockRunOf(account) : undefined;
    let accessToken = '';
    if (bedrock === undefined) {
      const resolved = await deps.resolveOAuth(accountId);
      if (!resolved.ok) {
        deps.logger.warn(
          { label, accountId, reason: resolved.reason },
          'ai call: account has no usable credential — trying the next',
        );
        continue;
      }
      accessToken = resolved.accessToken;
    }
    try {
      return await run(accessToken, bedrock);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        !isAccountExhausted((err as { limit?: LimitFacts }).limit, {
          probeBlocked: bedrock === undefined && deps.probeBlocked(accountId),
        })
      ) {
        // Not an account problem, so no other account would answer differently.
        deps.logger.warn({ label, accountId, err }, 'ai call: failed');
        throw err;
      }
      const marked = deps.rotation.markExhaustedWithSiblings(
        accounts,
        accountId,
        message.slice(0, 200),
        parseLimitResetsAt(message, Date.now()),
      );
      deps.logger.info(
        { label, accountId, alsoSidelined: marked.slice(1) },
        'ai call: account out of credit — trying the next',
      );
      deps.onMarked();
    }
  }
  deps.logger.warn(
    { label, tried: order, sidelined: deps.rotation.snapshot() },
    'ai call: every account is out of credit',
  );
  return null;
}
