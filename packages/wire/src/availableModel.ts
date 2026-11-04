// The model a new chat starts on when nobody chose one (spec/04 § Spawn).
//
// The account names a preferred default, but a chat started on a provider whose
// accounts are all signed out or out of usage fails on its first turn. So the
// default is the first model, in priority order, whose provider has an account
// that can run it right now. Priority order is the preferred default, then the
// model catalogue's own order. When no provider has one the preferred default
// stands: the turn is attempted and fails with the provider's own message.
//
// Only a KNOWN problem counts. A host that has not reported a provider's
// accounts yet is treated as usable, never as empty — greying out on a guess
// would be a fallback that hides the real state.

import { rateLimitWindowsBlocked, type RateLimitWindows } from './usageWindows.js';
import { backendIdForModel } from './providers.js';

/** One stored account as a host reports it. */
export interface ReportedAccount {
  connected: boolean;
  /** `apiKey` accounts have no rate limits to run out of. */
  kind?: string | undefined;
  needsSignIn?: boolean | undefined;
  usage?: RateLimitWindows | undefined;
}

/** A host's report for one backend; `accounts` is absent on a host that predates it. */
export interface ReportedBackend {
  accounts?: readonly ReportedAccount[] | undefined;
}

/** Can this one account run a turn right now? */
export function accountCanRun(account: ReportedAccount, now: number = Date.now()): boolean {
  if (!account.connected || account.needsSignIn === true) return false;
  if (account.kind === 'apiKey') return true;
  return !rateLimitWindowsBlocked(account.usage, now);
}

/** False only when the host has reported accounts for the backend and none can run. */
export function backendUsable(
  report: ReportedBackend | null | undefined,
  now: number = Date.now(),
): boolean {
  const accounts = report?.accounts;
  if (accounts === undefined) return true;
  return accounts.some((a) => accountCanRun(a, now));
}

/**
 * `preferred` if its provider can run, else the first catalogue model whose
 * provider can, else `preferred`.
 */
export function pickAvailableModel(input: {
  preferred: string;
  /** Model ids in the catalogue's own (priority) order. */
  catalogue: readonly string[];
  reportFor: (backendId: string) => ReportedBackend | null | undefined;
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  const usable = (model: string): boolean =>
    backendUsable(input.reportFor(backendIdForModel(model)), now);
  if (usable(input.preferred)) return input.preferred;
  return input.catalogue.find(usable) ?? input.preferred;
}
