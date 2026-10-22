// The providers Settings → Usage draws (spec/10 § Backend credentials).
//
// Every provider is one entry here and nothing else on the page: what it is
// called, which shared setting ranks its accounts, which limit windows it
// reports, where its extra-usage add-on is managed, and the control that adds
// an account. The page walks this list and draws each entry the same way, so
// a twentieth provider is a twentieth entry — not a branch in the page.

import type React from 'react';
import type { SharedBackendId, SharedState } from '../../api/rest';
import { EXTRA_USAGE_URL, type UsageScope } from '../../lib/usage';
import { AddChatGPT, AddClaude } from './AddAccounts';

export type SharedRow =
  | SharedState['secrets']['claude'][number]
  | SharedState['secrets']['codex'][number];

export interface ProviderSpec {
  id: SharedBackendId;
  name: string;
  /** Which key of the shared `accountStrategy` setting ranks this provider's accounts. */
  strategyKey: 'claude' | 'codex';
  windows: readonly UsageScope[];
  /** Where the extra-usage add-on is turned on, when the provider has one. */
  extraUsageUrl?: string;
  /** Whether an account's login can be replaced by pasting a token here. */
  pasteToken: boolean;
  rows: (secrets: SharedState['secrets']) => readonly SharedRow[];
  AddAccount: () => React.ReactElement;
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
    AddAccount: AddClaude,
  },
  {
    id: 'codex',
    name: 'Codex',
    strategyKey: 'codex',
    windows: ['session', 'week'],
    pasteToken: false,
    rows: (secrets) => secrets.codex,
    AddAccount: AddChatGPT,
  },
];
