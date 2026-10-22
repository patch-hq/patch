// The providers Settings → Usage draws (spec/10 § Backend credentials).
//
// Every provider is one entry here and nothing else on the page: what it is
// called, which shared setting ranks its accounts, which limit windows it
// reports and in what order, where its extra-usage add-on is managed, and the
// control that adds an account. The page walks this list and draws each entry
// the same way, so a twentieth provider is a twentieth entry — not a twentieth
// branch in the page.

import type { JSX } from 'react';
import type { SharedBackendId, SharedState } from '../../api/rest.js';
import { EXTRA_USAGE_URL, type UsageScope } from '../../lib/usage.js';
import { AddChatGPTAccount, AddClaudeAccount } from './SharedAccounts.js';

/** One account as the server stores it, whichever provider it is for. */
export interface SharedRow {
  id: string;
  label: string;
  connected: boolean;
  email?: string;
  organizationId?: string;
  kind?: 'chatgpt' | 'apiKey';
}

export interface ProviderSpec {
  id: SharedBackendId;
  name: string;
  /** Which key of the shared `accountStrategy` setting ranks this provider's accounts. */
  strategyKey: 'claude' | 'codex';
  /** The limit windows the provider reports, in the order they are drawn. */
  windows: readonly UsageScope[];
  /** Where the extra-usage add-on is turned on, when the provider has one. */
  extraUsageUrl?: string;
  /** Whether an account's login can be replaced by pasting a token here. */
  pasteToken: boolean;
  /** This provider's accounts in the shared secrets. */
  rows: (secrets: SharedState['secrets']) => SharedRow[];
  /** The control(s) that add an account, drawn under the provider's card. */
  AddAccount: () => JSX.Element;
}

export const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: 'claude-code',
    name: 'Claude',
    strategyKey: 'claude',
    windows: ['session', 'week', 'overage'],
    extraUsageUrl: EXTRA_USAGE_URL,
    pasteToken: true,
    rows: (secrets) => secrets.claude,
    AddAccount: AddClaudeAccount,
  },
  {
    id: 'codex',
    name: 'ChatGPT',
    strategyKey: 'codex',
    windows: ['session', 'week'],
    pasteToken: false,
    rows: (secrets) => secrets.codex,
    AddAccount: AddChatGPTAccount,
  },
];
