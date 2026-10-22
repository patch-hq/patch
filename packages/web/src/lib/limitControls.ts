// What the usage-limit card offers, and which of it can help (spec/12 § A usage
// or rate limit). The same four controls are always drawn; one that cannot
// help is disabled with the reason, never hidden — a missing button reads as
// "this app can't do that", a greyed one says why not right now.

import { PROVIDERS, providerForModel } from '@patch/wire';
import type { AccountUsageRow } from '../components/UsagePopover.js';
import { formatReset, isBlocked } from './usage.js';

export interface LimitControl {
  enabled: boolean;
  /** Why it is disabled; undefined when enabled. */
  reason?: string;
}

export interface LimitControls {
  send: LimitControl;
  account: LimitControl & { options: { id: string; label: string }[] };
  provider: LimitControl & { options: { id: string; label: string }[] };
  extraUsage: LimitControl;
  /** The filled button: the first enabled of account, provider, send. */
  main: 'account' | 'provider' | 'send' | null;
}

export function limitControls(input: {
  now: number;
  resetsAt: number | null;
  /** The account the blocked turn ran on. */
  currentAccountId: string | undefined;
  /** The provider the chat runs on, from its model. */
  currentProviderId: string;
  rows: readonly AccountUsageRow[];
  overageBlocked: boolean;
}): LimitControls {
  const { now, resetsAt, rows } = input;
  const left = rows.filter((r) => !isBlocked(r.usage, now));

  const send: LimitControl =
    resetsAt !== null && resetsAt > now
      ? { enabled: false, reason: `Available at ${formatReset(resetsAt, now)}` }
      : { enabled: true };

  const accountOptions = left
    .filter(
      (r) => r.providerId === input.currentProviderId && r.accountId !== input.currentAccountId,
    )
    .map((r) => ({ id: r.accountId, label: r.label }));
  const account = accountOptions.length
    ? { enabled: true, options: accountOptions }
    : { enabled: false, reason: 'No other account has usage left', options: accountOptions };

  const providerOptions = PROVIDERS.filter(
    (p) => p.id !== input.currentProviderId && left.some((r) => r.providerId === p.id),
  ).map((p) => ({ id: p.id as string, label: p.label }));
  const provider = providerOptions.length
    ? { enabled: true, options: providerOptions }
    : { enabled: false, reason: 'No other provider has usage left', options: providerOptions };

  const extraUsage: LimitControl = input.overageBlocked
    ? { enabled: true }
    : { enabled: false, reason: 'Extra usage is already on' };

  const main = account.enabled
    ? 'account'
    : provider.enabled
      ? 'provider'
      : send.enabled
        ? 'send'
        : null;
  return { send, account, provider, extraUsage, main };
}

/** `16 min`, `2 h 5 min`, `3 d 4 h` — the compact span the card's corner uses. */
export function formatSpanShort(ms: number): string {
  const totalMin = Math.max(1, Math.floor(ms / 60_000));
  if (totalMin < 60) return `${totalMin} min`;
  const hours = Math.floor(totalMin / 60);
  if (hours < 24) return totalMin % 60 === 0 ? `${hours} h` : `${hours} h ${totalMin % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

export { providerForModel };
