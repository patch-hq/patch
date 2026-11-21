// Whether the connected AI accounts have usage left. "Connected" only says a
// sign-in worked; an account that has used its week is connected and unusable,
// and the setup steps and the guide must not call that ready.

import { useMemo } from 'react';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { accountRows, type AccountUsageRow } from '../components/UsagePopover.js';
import { blockingScope, formatReset, isBlocked } from './usage.js';

export interface AccountsLimit {
  /** When the first blocked account is usable again; null when it did not say. */
  until: number | null;
}

/**
 * The limit shared by `rows`, or null when any of them still has usage left
 * (or there are none, or no reading has arrived yet). Accounts with no reading
 * count as usable: silence is not a limit.
 */
export function limitOf(rows: readonly AccountUsageRow[], now: number): AccountsLimit | null {
  if (rows.length === 0) return null;
  if (!rows.every((r) => isBlocked(r.usage, now))) return null;
  const resets = rows
    .map((r) => {
      const scope = blockingScope(r.usage, now);
      return scope ? r.usage?.[scope]?.resetsAt : undefined;
    })
    .filter((t): t is number => t !== undefined && t > now);
  return { until: resets.length ? Math.min(...resets) : null };
}

/** "Connected, but this account has no usage left until Tue 20:00". */
export function noUsageText(limit: AccountsLimit, now: number, plural = false): string {
  const who = plural ? 'these accounts have' : 'this account has';
  return limit.until === null
    ? `Connected, but ${who} no usage left`
    : `Connected, but ${who} no usage left until ${formatReset(limit.until, now)}`;
}

/** The limit across every connected account, or null if any can still work. */
export function useAllAccountsLimit(): AccountsLimit | null {
  const hosts = usePresenceStore((s) => s.hosts);
  const shared = usePreferencesStore((s) => s.shared);
  return useMemo(() => limitOf(accountRows(hosts, shared), Date.now()), [hosts, shared]);
}

/** The limit on one backend's accounts (`claude-code`, `codex`), or null. */
export function useBackendLimit(backendId: string): AccountsLimit | null {
  const hosts = usePresenceStore((s) => s.hosts);
  const shared = usePreferencesStore((s) => s.shared);
  return useMemo(
    () =>
      limitOf(
        accountRows(hosts, shared).filter((r) => r.key.startsWith(`${backendId}:`)),
        Date.now(),
      ),
    [hosts, shared, backendId],
  );
}
