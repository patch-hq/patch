// Which accounts and providers still have usage to spend — what the new-chat
// screen uses to default to an account in credit and to grey out models whose
// provider has none left.
//
// Only a KNOWN refusal counts as spent. An account nothing has read yet is not
// reported as empty: that would grey out models on a guess (NO FALLBACK cuts
// both ways — an unanswered question stays unanswered, it is not "spent").
// An API-key account has no rate limits to read, so a provider that has one
// connected always has credit.

import { useMemo } from 'react';
import {
  ACCOUNT_PROVIDERS,
  bedrockAtCap,
  providerForModel,
  rateLimitWindowBlocks,
  type ProviderId,
} from '@patch/wire';
import { accountRows, type AccountUsageRow } from '../components/UsagePopover.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { formatResetLocal, isBlocked } from './usage.js';

/** The connected API-key accounts per provider, which `accountRows` leaves out. */
export type ApiKeyProviders = ReadonlySet<ProviderId>;

/**
 * The accounts a chat on `hostId` could be routed to without naming one: in
 * the order (`auto` on), and, for a Bedrock account, on that host and under
 * its monthly cap. A Bedrock account on another host never runs there, and one
 * at its cap is limited, so neither may be chosen as the default or counted as
 * credit left. With no host known, no Bedrock account counts.
 */
export function routableRows(
  rows: readonly AccountUsageRow[],
  hostId: string | null | undefined,
  now: number = Date.now(),
): AccountUsageRow[] {
  return rows.filter(
    (r) =>
      r.auto !== false &&
      (r.bedrock === undefined || (r.bedrock.hostId === hostId && !bedrockAtCap(r.bedrock, now))),
  );
}

/** Spent: a refusing usage reading, or a Bedrock account at its monthly cap. */
function rowSpent(r: AccountUsageRow, now: number): boolean {
  return isBlocked(r.usage, now) || (r.bedrock !== undefined && bedrockAtCap(r.bedrock, now));
}

/** The first account of `providerId` that is not refusing work, or null. */
export function firstInCreditAccountId(
  rows: readonly AccountUsageRow[],
  providerId: ProviderId,
  now: number = Date.now(),
): string | null {
  const row = rows.find(
    (r) => r.providerId === providerId && r.auto !== false && !rowSpent(r, now),
  );
  return row?.accountId ?? null;
}

/**
 * The account a new chat should start on instead of leaving it to the
 * strategy: the first one in credit, but only when another account of the same
 * provider is known to be spent. With nothing spent there is nothing to steer
 * around, so the strategy (Auto) keeps the choice.
 */
export function creditDefaultAccountId(
  rows: readonly AccountUsageRow[],
  providerId: ProviderId,
  now: number = Date.now(),
): string | null {
  // Only accounts the strategy could pick: one with `auto` off is never a
  // default, and its being spent is nothing to steer around.
  const own = rows.filter((r) => r.providerId === providerId && r.auto !== false);
  if (!own.some((r) => rowSpent(r, now))) return null;
  return firstInCreditAccountId(own, providerId, now);
}

/**
 * True when `providerId` has accounts and every one of them is refusing work.
 * A provider with no accounts at all is a sign-in problem, handled elsewhere,
 * and one with an API key never runs dry.
 */
export function providerSpent(
  rows: readonly AccountUsageRow[],
  providerId: ProviderId,
  apiKeyProviders: ApiKeyProviders,
  now: number = Date.now(),
): boolean {
  if (apiKeyProviders.has(providerId)) return false;
  const own = rows.filter((r) => r.providerId === providerId && r.auto !== false);
  return own.length > 0 && own.every((r) => rowSpent(r, now));
}

/** True when a model's provider has no usage left. */
export function modelSpent(
  modelId: string | null | undefined,
  rows: readonly AccountUsageRow[],
  apiKeyProviders: ApiKeyProviders,
  now: number = Date.now(),
): boolean {
  return providerSpent(rows, providerForModel(modelId), apiKeyProviders, now);
}

/**
 * Why a model is greyed out, in words — `ChatGPT limit reached until 17 Dec 10:16`
 * — or null when it is not spent. The date is when the first account of the
 * provider comes back; no reset known says only that the limit is reached.
 */
export function modelSpentReason(
  modelId: string | null | undefined,
  rows: readonly AccountUsageRow[],
  apiKeyProviders: ApiKeyProviders,
  now: number = Date.now(),
): string | null {
  const providerId = providerForModel(modelId);
  if (!providerSpent(rows, providerId, apiKeyProviders, now)) return null;
  const own = rows.filter((r) => r.providerId === providerId && r.auto !== false);
  const name = own[0]!.backend;
  // An account is back when its last blocked window resets; the provider is
  // back when its soonest account is. Any account with no stated reset makes
  // the date unknowable, so none is claimed.
  const backAt = own.map((r) => {
    const resets = (['session', 'week'] as const)
      .filter((scope) => rateLimitWindowBlocks(scope, r.usage?.[scope], now))
      .map((scope) => r.usage?.[scope]?.resetsAt);
    return resets.some((t) => t === undefined) ? undefined : Math.max(...(resets as number[]));
  });
  if (backAt.some((t) => t === undefined)) return `${name} limit reached`;
  return `${name} limit reached until ${formatResetLocal(Math.min(...(backAt as number[])), now)}`;
}

/**
 * The account rows a chat on `hostId` could be routed to (`routableRows`) and
 * the API-key providers, read from the stores.
 */
/**
 * The rows credit is judged on. A chat that names an account runs only on it,
 * whatever its `auto` (spec/10 § Choosing an account), so its credit is that
 * account's alone; otherwise the accounts the strategy could pick.
 */
export function creditRows(
  rows: readonly AccountUsageRow[],
  hostId: string | null | undefined,
  lockedAccountId: string | null | undefined,
  now: number = Date.now(),
): AccountUsageRow[] {
  if (lockedAccountId) {
    const locked = rows.find((r) => r.accountId === lockedAccountId);
    if (locked && (locked.bedrock === undefined || locked.bedrock.hostId === hostId)) {
      return [{ ...locked, auto: true }];
    }
  }
  return routableRows(rows, hostId, now);
}

export function useCredit(
  hostId: string | null | undefined,
  lockedAccountId?: string | null,
): {
  rows: AccountUsageRow[];
  apiKeyProviders: ApiKeyProviders;
} {
  const hosts = usePresenceStore((s) => s.hosts);
  const shared = usePreferencesStore((s) => s.shared);
  return useMemo(() => {
    const apiKeyProviders = new Set<ProviderId>();
    if (shared !== null) {
      for (const p of ACCOUNT_PROVIDERS) {
        const accounts = shared.secrets[p.accountsKey] as readonly {
          connected: boolean;
          kind?: string;
        }[];
        if (accounts.some((a) => a.connected && a.kind === 'apiKey')) {
          apiKeyProviders.add(p.id as ProviderId);
        }
      }
    }
    return {
      rows: creditRows(accountRows(hosts, shared), hostId, lockedAccountId),
      apiKeyProviders,
    };
  }, [hosts, shared, hostId, lockedAccountId]);
}
