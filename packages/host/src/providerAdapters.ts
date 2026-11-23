// The host's per-provider adapters (spec/02 § Provider adapters).
//
// One entry per provider, built where the host is wired together. Everything the
// host does that differs by provider — run a turn, resolve its credential,
// report its accounts — goes through the adapter for the chat's model, so the
// wiring never asks "is this Codex?". Adding a provider is adding an entry here;
// `adapterForModel` is the only lookup.

import type { AccountStrategy, ChatErrorCode, HarnessId } from '@patch/wire';
import { providerForModel } from '@patch/wire';
import type { BedrockRun, SdkBackend } from './sdkBackend.js';
import type { OwnConfigFile } from './providerSettings.js';

export type CredentialResult =
  /** `bedrock` set: a Claude on Amazon Bedrock account, `accessToken` `''`. */
  | { ok: true; accessToken: string; accountId?: string; bedrock?: BedrockRun }
  /** `code` and `limit`: as `OAuthCheckResult` (chatRunner.ts). */
  | {
      ok: false;
      reason: string;
      code?: ChatErrorCode;
      limit?: { accountId: string; resetsAt: number };
    };

export interface TurnAccountHint {
  chatId: string;
  preferredAccountId?: string;
  sessionAccountId?: string;
  /** Only asking where this chat would run (a spawn's check): no round-robin moves on. */
  check?: boolean;
  /** The user asked this chat to run now: its lock does not hold it to a spent account. */
  anyAccount?: boolean;
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
  /**
   * The provider's own configuration files on this host that its own settings
   * are written into (spec/10 § Provider settings), in the format its
   * descriptor declares. Empty for a provider with none here.
   */
  ownConfigs(): OwnConfigFile[];
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
