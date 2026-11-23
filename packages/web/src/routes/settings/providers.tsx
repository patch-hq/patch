// The providers Settings → Usage and the welcome step draw (spec/10 § Backend
// credentials).
//
// Every provider is one entry here and nothing else on the page: what it is
// called, which limit windows it reports and in what order, where its
// extra-usage add-on is managed, how an account is signed in, and the controls
// that add one. Where its accounts sit in the shared settings, and which
// strategy setting ranks them, come from the provider table in @patch/wire
// (`accountsKey`). The pages walk this list and draw each entry the same way,
// so a twentieth provider is a twentieth entry — not a twentieth branch.

import type { JSX } from 'react';
import {
  accountsForBackend,
  accountsKeyForBackend,
  type AccountState,
  type ClaudeBedrock,
  type ProviderAccountsKey,
} from '@patch/wire';
import type { SharedBackendId, SharedState } from '../../api/rest.js';
import { EXTRA_USAGE_URL, type UsageScope } from '../../lib/usage.js';
import { ChatGPTSignIn } from '../../components/ChatGPTSignIn.js';
import { ClaudeSignIn } from '../../components/ClaudeSignIn.js';
import {
  AddChatGPTAccount,
  AddClaudeAccount,
  ClaudeListFoot,
  WelcomeClaudeControls,
} from './SharedAccounts.js';

/** One account as the server stores it, whichever provider it is for. */
export interface SharedRow {
  id: string;
  label: string;
  connected: boolean;
  email?: string;
  organizationId?: string;
  kind?: 'chatgpt' | 'apiKey';
  /** The account's one state, from the server (spec/10 § Account states). */
  state?: AccountState;
  /** In the order (spec/10 § Choosing an account); absent reads as on. */
  auto?: boolean;
  /** A Claude on Amazon Bedrock account. */
  bedrock?: ClaudeBedrock;
}

/** What a provider entry says; the rest is derived from the wire table. */
interface ProviderEntry {
  id: SharedBackendId;
  name: string;
  /** The limit windows the provider reports, in the order they are drawn. */
  windows: readonly UsageScope[];
  /** Where the extra-usage add-on is turned on, when the provider has one. */
  extraUsageUrl?: string;
  /** Whether an account's login can be replaced by pasting a token here. */
  pasteToken: boolean;
  /** What the account menu's Sign in item says it does. */
  signInDetail: string;
  /** The sign-in drawn under an account row being signed in again. */
  SignIn: (props: { accountId: string; onDone: () => void }) => JSX.Element;
  /** The control(s) that add an account, drawn under the provider's card. */
  AddAccount: () => JSX.Element | null;
  /** Whether each account carries an Auto checkbox: in the order or only when chosen. */
  autoFlag: boolean;
  /** Drawn in the card under the list: an add or edit form the add control opened. */
  ListFoot?: () => JSX.Element | null;
  /** The provider's card on the welcome step and the Connect page. */
  welcome: {
    name: string;
    testId: string;
    /** The sign-in controls on the card before any account is connected. */
    Controls: () => JSX.Element;
    /** How the provider's CLI is named while it installs on a host. */
    installName: string;
    installTestId: string;
  };
}

export interface ProviderSpec extends ProviderEntry {
  /** Which key of the shared `accountStrategy` setting ranks this provider's accounts. */
  strategyKey: ProviderAccountsKey;
  /** This provider's accounts in the shared secrets. */
  rows: (secrets: SharedState['secrets']) => SharedRow[];
}

function spec(entry: ProviderEntry): ProviderSpec {
  return {
    ...entry,
    strategyKey: accountsKeyForBackend(entry.id),
    rows: (secrets) => accountsForBackend<SharedRow>(secrets, entry.id) as SharedRow[],
  };
}

export const PROVIDERS: readonly ProviderSpec[] = [
  spec({
    id: 'claude-code',
    name: 'Claude',
    windows: ['session', 'week', 'overage'],
    extraUsageUrl: EXTRA_USAGE_URL,
    pasteToken: true,
    signInDetail: 'Sign in with Claude in your browser',
    SignIn: ClaudeSignIn,
    AddAccount: AddClaudeAccount,
    autoFlag: true,
    ListFoot: ClaudeListFoot,
    welcome: {
      name: 'Claude',
      testId: 'claude',
      Controls: WelcomeClaudeControls,
      installName: 'Claude Code',
      installTestId: 'claude',
    },
  }),
  spec({
    id: 'codex',
    name: 'ChatGPT',
    windows: ['session', 'week'],
    pasteToken: false,
    signInDetail: 'Sign in with ChatGPT using a code you approve on any device',
    SignIn: ChatGPTSignIn,
    AddAccount: AddChatGPTAccount,
    autoFlag: false,
    welcome: {
      name: 'ChatGPT and OpenAI',
      testId: 'chatgpt',
      Controls: AddChatGPTAccount,
      installName: 'ChatGPT',
      installTestId: 'codex',
    },
  }),
];
