// The host's per-provider adapters (spec/02 § Provider adapters).
//
// One entry per provider, built where the host is wired together. Everything the
// host does that differs by provider — run a turn, resolve its credential,
// report its accounts — goes through the adapter for the chat's model, so the
// wiring never asks "is this Codex?". Adding a provider is adding an entry here;
// `adapterForModel` is the only lookup.

import type { AccountStrategy, HarnessId } from '@patch/wire';
import { providerForModel } from '@patch/wire';
import type { SdkBackend } from './sdkBackend.js';

export type CredentialResult =
  | { ok: true; accessToken: string; accountId?: string }
  | { ok: false; reason: string };

export interface TurnAccountHint {
  chatId: string;
  preferredAccountId?: string;
  sessionAccountId?: string;
}

export interface ProviderAdapter {
  /** Run a turn on this provider. */
  run: SdkBackend['run'];
  /** The credential a turn on `model` runs under, or why there is none. */
  resolveCredential(model: string | undefined, turn?: TurnAccountHint): Promise<CredentialResult>;
  /** The accounts this host holds for the provider, in the shared order. */
  /** The accounts a chat on `model` can run on, or be locked to. */
  heldAccounts(model: string | undefined): Array<{ id: string; label: string }>;
  /** An account's label, if the host holds it. */
  accountLabel(accountId: string): string | undefined;
  /** Is a move off `fromAccountId` because it is out of credit, and until when. */
  accountSpent(fromAccountId: string): { spent: boolean; until?: number };
  /** Record an exhausted account and name the one to retry on, if any. */
  nextAccountAfterExhausted(
    chatId: string,
    spentAccountId: string | undefined,
    message: string,
    limit?: { resetsAt?: number },
  ): string | undefined;
  /** How far through its accounts exhaustion has got; undefined when the provider has nothing to say. */
  accountRouting(): AccountRouting | undefined;
}

export interface AccountRouting {
  strategy: AccountStrategy;
  accounts: number;
  exhausted: number;
  nextResetsAt?: number;
  nextLabel?: string;
}

export type ProviderAdapters = Record<HarnessId, ProviderAdapter>;

export function adapterForModel(
  adapters: ProviderAdapters,
  model: string | null | undefined,
): ProviderAdapter {
  return adapters[providerForModel(model)];
}
