// The providers Settings → Usage draws (spec/10 § Backend credentials).
//
// Every provider is one entry here and nothing else on the page: what it is
// called, which limit windows it reports, where its extra-usage add-on is
// managed, how an account is signed in, and the control that adds one. Where
// its accounts sit in the shared settings, and the strategy setting that ranks
// them, come from the provider table in @patch/wire (`accountsKey`). The page walks this list and draws each entry the same way, so
// a twentieth provider is a twentieth entry — not a branch in the page.

import type React from 'react';
import { accountsForBackend, accountsKeyForBackend, type ProviderAccountsKey } from '@patch/wire';
import type { SharedBackendId, SharedState } from '../../api/rest';
import { EXTRA_USAGE_URL, type UsageScope } from '../../lib/usage';
import { AddChatGPT, AddClaude } from './AddAccounts';
import { ChatGPTSignInFlow, ClaudeSignInFlow } from './SignInFlows';

export type SharedRow =
  | SharedState['secrets']['claude'][number]
  | SharedState['secrets']['codex'][number];

/** What a provider entry says; the rest is derived from the wire table. */
interface ProviderEntry {
  id: SharedBackendId;
  name: string;
  windows: readonly UsageScope[];
  /** Where the extra-usage add-on is turned on, when the provider has one. */
  extraUsageUrl?: string;
  /** Whether an account's login can be replaced by pasting a token here. */
  pasteToken: boolean;
  /**
   * Whether each account carries `auto`, in the order or not (spec/10 §
   * Choosing an account): every row starts with its checkbox.
   */
  autoFlag: boolean;
  /** What the account menu's Sign in item says, for a provider with no token to paste. */
  signInDetail: string;
  /** The sign-in drawn under an account row being signed in again. */
  SignInFlow: (props: { accountId: string; onDone: () => void }) => React.ReactElement;
  AddAccount: () => React.ReactElement;
}

export interface ProviderSpec extends ProviderEntry {
  /** Which key of the shared `accountStrategy` setting ranks this provider's accounts (`accountsKey`). */
  strategyKey: ProviderAccountsKey;
  rows: (secrets: SharedState['secrets']) => readonly SharedRow[];
}

function spec(entry: ProviderEntry): ProviderSpec {
  return {
    ...entry,
    strategyKey: accountsKeyForBackend(entry.id),
    rows: (secrets) => accountsForBackend<SharedRow>(secrets, entry.id),
  };
}

export const PROVIDERS: readonly ProviderSpec[] = [
  spec({
    id: 'claude-code',
    name: 'Claude',
    windows: ['session', 'week', 'overage'],
    extraUsageUrl: EXTRA_USAGE_URL,
    pasteToken: true,
    autoFlag: true,
    signInDetail: 'Sign in with Claude in your browser',
    SignInFlow: ClaudeSignInFlow,
    AddAccount: AddClaude,
  }),
  spec({
    id: 'codex',
    name: 'Codex',
    windows: ['session', 'week'],
    pasteToken: false,
    autoFlag: false,
    signInDetail: 'Sign in with ChatGPT using a code you approve on any device',
    SignInFlow: ChatGPTSignInFlow,
    AddAccount: AddChatGPT,
  }),
];
