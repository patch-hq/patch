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
import { PROVIDERS, providerForModel, type ProviderId } from '@patch/wire';
import { accountRows, type AccountUsageRow } from '../components/UsagePopover.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { isBlocked } from './usage.js';

/** The connected API-key accounts per provider, which `accountRows` leaves out. */
export type ApiKeyProviders = ReadonlySet<ProviderId>;

/** The first account of `providerId` that is not refusing work, or null. */
export function firstInCreditAccountId(
  rows: readonly AccountUsageRow[],
  providerId: ProviderId,
  now: number = Date.now(),
): string | null {
  const row = rows.find((r) => r.providerId === providerId && !isBlocked(r.usage, now));
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
  const own = rows.filter((r) => r.providerId === providerId);
  if (!own.some((r) => isBlocked(r.usage, now))) return null;
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
  const own = rows.filter((r) => r.providerId === providerId);
  return own.length > 0 && own.every((r) => isBlocked(r.usage, now));
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

/** The rate-limited account rows and the API-key providers, read from the stores. */
export function useCredit(): { rows: AccountUsageRow[]; apiKeyProviders: ApiKeyProviders } {
  const hosts = usePresenceStore((s) => s.hosts);
  const shared = usePreferencesStore((s) => s.shared);
  return useMemo(() => {
    const apiKeyProviders = new Set<ProviderId>();
    if (shared !== null) {
      for (const p of PROVIDERS) {
        const accounts = shared.secrets[p.accountsKey] as readonly {
          connected: boolean;
          kind?: string;
        }[];
        if (accounts.some((a) => a.connected && a.kind === 'apiKey')) {
          apiKeyProviders.add(p.id as ProviderId);
        }
      }
    }
    return { rows: accountRows(hosts, shared), apiKeyProviders };
  }, [hosts, shared]);
}
