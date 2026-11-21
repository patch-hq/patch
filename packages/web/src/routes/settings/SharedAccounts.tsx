// Usage → one provider's accounts (spec/10 § Backend credentials).
//
// The accounts are shared settings (spec/01 § Settings): one ordered list per
// provider, held on the server and sent to every host. Every change here is a
// server write and settles on its answer. A host is only ever the READER of an
// account — it takes the usage reading — and the freshest reading from any
// host is what is shown; which host took it is not something this page says,
// because an account belongs to nobody's host.

import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import {
  accountStateRunnable,
  describeAccountState,
  type AccountStrategy,
  type HostAccountSummary,
} from '@patch/wire';
import { ChatGPTSignIn } from '../../components/ChatGPTSignIn.js';
import { ClaudeSignIn } from '../../components/ClaudeSignIn.js';
import { api, type SharedBackendId } from '../../api/rest.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { formatAgo, formatResetLocal } from '../../lib/usage.js';
import { writeShared } from './sharedWrite.js';
import { AccountRow, RankedList, UsageBars, type MenuItem } from './accountList.js';
import { Note, Pills, Row } from './ui.js';
import type { ProviderSpec, SharedRow } from './providers.js';

export const STRATEGIES: readonly AccountStrategy[] = [
  'priority',
  'round-robin',
  'soonest-reset',
  'least-used',
];
export const STRATEGY_LABELS: Record<AccountStrategy, string> = {
  priority: 'Priority',
  'round-robin': 'Round robin',
  'soonest-reset': 'Soonest reset',
  'least-used': 'Least used',
};
/** What each strategy does, in one sentence, shown on hover (spec/10 § Backend credentials). */
export const STRATEGY_TITLES: Record<AccountStrategy, string> = {
  priority: 'The first account here that still has allowance',
  'round-robin': 'Each turn takes the next account along, spent evenly',
  'soonest-reset': 'The account whose weekly limit resets soonest',
  'least-used': 'The account with the most allowance left right now',
};

/** The freshest reading of an account any host has taken. */
function useReading(backendId: SharedBackendId, accountId: string): HostAccountSummary | null {
  const hosts = usePresenceStore((s) => s.hosts);
  let best: HostAccountSummary | null = null;
  for (const host of Object.values(hosts)) {
    const summary = host.accounts[backendId]?.accounts?.find((a) => a.id === accountId);
    if (!summary) continue;
    if (best === null || (summary.usage?.at ?? 0) > (best.usage?.at ?? 0)) best = summary;
  }
  return best;
}

/** One provider's shared accounts, ranked, with the strategy that picks among them. */
export function SharedAccounts({ provider }: { provider: ProviderSpec }): JSX.Element {
  const backendId = provider.id;
  const shared = usePreferencesStore((s) => s.shared);
  const strategy = usePreferencesStore((s) => s.preferences.accountStrategy[provider.strategyKey]);
  const loaded = usePreferencesStore((s) => s.loaded);
  if (shared === null) return <Note testid={`accounts-loading-${backendId}`}>Loading…</Note>;
  const rows = provider.rows(shared.secrets);
  const name = provider.name;

  return (
    <div data-testid={`accounts-${backendId}`}>
      {rows.length > 0 ? (
        <Row title="Pick the account by" testid={`strategy-row-${backendId}`}>
          <Pills
            label={`${name} account strategy`}
            options={STRATEGIES}
            value={strategy}
            disabled={!loaded}
            labels={STRATEGY_LABELS}
            titles={STRATEGY_TITLES}
            testid={`strategy-${backendId}`}
            onChange={(next) =>
              void writeShared(`${name} strategy`, () => api.setAccountStrategy(backendId, next))
            }
          />
        </Row>
      ) : null}
      {rows.length === 0 ? (
        <Note testid={`accounts-empty-${backendId}`}>No {name} accounts yet</Note>
      ) : (
        <RankedList
          testid={`accounts-rank-${backendId}`}
          onCommit={(next) =>
            writeShared(`${name} order`, () => api.orderAccounts(backendId, next))
          }
          items={rows.map((a) => ({
            id: a.id,
            render: (handle: ReactNode, rank: number) => (
              <AccountEntry provider={provider} row={a} rows={rows} handle={handle} rank={rank} />
            ),
          }))}
        />
      )}
    </div>
  );
}

function AccountEntry({
  provider,
  row,
  rows,
  handle,
  rank,
}: {
  provider: ProviderSpec;
  row: SharedRow;
  rows: SharedRow[];
  handle: ReactNode;
  rank: number;
}): JSX.Element {
  const backendId = provider.id;
  const reading = useReading(backendId, row.id);
  const [signingIn, setSigningIn] = useState(false);
  const name = provider.name;
  const id = `${backendId}-${row.id}`;
  // Two rows on one Claude organisation are one pool of credit under two
  // labels: failover between them has nowhere to go, so it is said.
  const twin =
    row.organizationId === undefined
      ? undefined
      : rows.find((r) => r.id !== row.id && r.organizationId === row.organizationId);
  // When the reading was taken sits beside the name, where the eye lands
  // first; the sub-line is what the account IS (its email, its kind).
  const ago = formatAgo(reading?.usage?.at);
  const email = row.email === row.label ? null : (row.email ?? null);
  const sub = [email, row.kind === 'apiKey' ? 'API key' : null].filter(
    (x): x is string => x !== null,
  );

  const pasteToken = (title: string, verb: string): void =>
    void (async () => {
      const token = await useUiStore.getState().prompt({
        title,
        message: 'Paste a token from `claude setup-token`:',
        placeholder: 'sk-ant-oat01-…',
        confirmLabel: verb,
      });
      if (token === null || token.trim() === '') return;
      await writeShared('sign in', () =>
        api.updateAccount(backendId, row.id, { token: token.trim() }),
      );
    })();

  const menu: MenuItem[] = [
    {
      label: 'Rename',
      testid: `account-rename-${id}`,
      onSelect: () =>
        void (async () => {
          const label = await useUiStore.getState().prompt({
            title: `Rename ${row.label}`,
            message: 'New name:',
            placeholder: row.label,
            confirmLabel: 'Rename',
          });
          if (label === null || label.trim() === '') return;
          await writeShared('rename', () =>
            api.updateAccount(backendId, row.id, { label: label.trim() }),
          );
        })(),
    },
    ...(provider.pasteToken && row.kind === 'apiKey'
      ? [
          {
            label: 'Replace key',
            detail: 'Use a different Anthropic API key for this account',
            testid: `account-paste-${id}`,
            onSelect: () =>
              void (async () => {
                const key = await useUiStore.getState().prompt({
                  title: `Replace the key for ${row.label}`,
                  message: 'Paste the new key:',
                  placeholder: 'sk-ant-api03-…',
                  confirmLabel: 'Replace',
                });
                if (key === null || key.trim() === '') return;
                await writeShared('replace key', () =>
                  api.updateAccount(backendId, row.id, { token: key.trim() }),
                );
              })(),
          },
        ]
      : provider.pasteToken
        ? [
            {
              label: row.connected ? 'Sign in again' : 'Sign in',
              detail: provider.signInDetail,
              testid: `account-connect-${id}`,
              onSelect: () => setSigningIn(true),
            },
            {
              label: 'Use a setup token',
              detail: 'Use a token from `claude setup-token` instead',
              testid: `account-paste-${id}`,
              onSelect: () =>
                pasteToken(
                  `${row.connected ? 'Sign in again to' : 'Sign in to'} ${row.label}`,
                  'Sign in',
                ),
            },
          ]
        : []),
    // A provider with no token to paste signs a row in with its own flow; an
    // API-key row has nothing to sign in to.
    ...(!provider.pasteToken && row.kind !== 'apiKey'
      ? [
          {
            label: row.connected ? 'Sign in again' : 'Sign in',
            detail: provider.signInDetail,
            testid: `account-connect-${id}`,
            onSelect: () => setSigningIn(true),
          },
        ]
      : []),
    ...(row.connected
      ? [
          {
            label: 'Sign out',
            detail: 'Keep the row, forget the login: nothing uses it until it is signed in again',
            danger: true,
            testid: `account-disconnect-${id}`,
            onSelect: () =>
              void (async () => {
                const ok = await useUiStore.getState().confirm({
                  title: `Sign out of ${row.label}`,
                  message: `Sign out of ${row.label}? Every host stops using it until it is signed in again.`,
                  confirmLabel: 'Sign out',
                  danger: true,
                });
                if (ok)
                  await writeShared('sign out', () => api.disconnectAccount(backendId, row.id));
              })(),
          },
        ]
      : []),
    {
      label: 'Remove',
      detail: 'Forget this account everywhere',
      danger: true,
      testid: `account-remove-${id}`,
      onSelect: () =>
        void (async () => {
          const ok = await useUiStore.getState().confirm({
            title: `Remove ${row.label}`,
            message: `Remove ${row.label} from every host? Its row goes too.`,
            confirmLabel: 'Remove',
            danger: true,
          });
          if (ok) await writeShared('remove', () => api.removeAccount(backendId, row.id));
        })(),
    },
  ];

  return (
    <AccountRow
      handle={handle}
      rank={rank}
      active={false}
      testid={`account-${id}`}
      menuLabel={row.label}
      menuTestid={`account-menu-${id}`}
      menu={menu}
    >
      <span className="set-row-title">
        {row.label}
        {ago ? (
          <span className="set-ago" data-testid={`account-read-${id}`}>
            {ago}
          </span>
        ) : null}
      </span>
      {sub.length > 0 ? <span className="set-sub">{sub.join(' · ')}</span> : null}
      {row.state &&
      (row.kind === 'apiKey' || reading?.usage !== undefined || row.state.state !== 'ready') ? (
        <span
          className={`set-sub${accountStateRunnable(row.state) ? '' : ' warn'}`}
          data-testid={`account-state-${id}`}
          data-state={row.state.state}
        >
          {describeAccountState(row.state, formatResetLocal)}
        </span>
      ) : null}
      {twin ? (
        <span className="set-sub warn" data-testid={`account-twin-${id}`}>
          Same {name} account as {twin.label}
        </span>
      ) : null}
      {reading?.error ? (
        <p className="set-error" role="alert">
          {reading.error}
        </p>
      ) : null}
      {signingIn ? <provider.SignIn accountId={row.id} onDone={() => setSigningIn(false)} /> : null}
      <UsageBars
        usage={reading?.usage}
        windows={provider.windows}
        extraUsageUrl={provider.extraUsageUrl}
        testId={`account-usage-${id}`}
        testIdFor={(scope) => `account-usage-${scope}-${id}`}
      />
    </AccountRow>
  );
}

/** Add a Claude account: sign in in the browser, or paste a `claude setup-token` token. */
export function AddClaudeApiKey(): JSX.Element {
  return (
    <button
      type="button"
      className="set-btn ghost"
      data-testid="claude-add-api-key"
      onClick={() =>
        void (async () => {
          const key = await useUiStore.getState().prompt({
            title: 'Add an Anthropic API key',
            message: 'Paid per use. Paste the key:',
            placeholder: 'sk-ant-api03-…',
            confirmLabel: 'Add',
          });
          if (key === null || key.trim() === '') return;
          await writeShared('add API key', () =>
            api.addAccount('claude-code', { apiKey: key.trim() }),
          );
        })()
      }
    >
      Add API key
    </button>
  );
}

/** Claude's card on the welcome step: sign in in the browser, or add an API key. */
export function WelcomeClaudeControls(): JSX.Element {
  return <ClaudeSignIn primary apiKey={<AddClaudeApiKey />} />;
}

export function AddClaudeAccount(): JSX.Element {
  return (
    <div className="set-inline set-add-bar start">
      <ClaudeSignIn apiKey={<AddClaudeApiKey />} />
      <button
        type="button"
        className="set-btn ghost"
        data-testid="add-claude-account"
        onClick={() =>
          void (async () => {
            const token = await useUiStore.getState().prompt({
              title: 'Add a Claude account',
              message: 'Paste a token from `claude setup-token`:',
              placeholder: 'sk-ant-oat01-…',
              confirmLabel: 'Add',
            });
            if (token === null || token.trim() === '') return;
            await writeShared('add account', () =>
              api.addAccount('claude-code', { token: token.trim() }),
            );
          })()
        }
      >
        Use a setup token
      </button>
    </div>
  );
}

/**
 * Add a ChatGPT account: a device sign-in the server runs, or an API key added
 * straight to the server. No host is involved in either.
 */
export function AddChatGPTAccount(): JSX.Element {
  return (
    <div className="set-add-bar start stack" data-testid="add-chatgpt-account">
      <ChatGPTSignIn apiKey={<AddChatGPTApiKey />} />
    </div>
  );
}

function AddChatGPTApiKey(): JSX.Element {
  return (
    <button
      type="button"
      className="set-btn ghost"
      data-testid="chatgpt-add-api-key"
      onClick={() =>
        void (async () => {
          const key = await useUiStore.getState().prompt({
            title: 'Add an OpenAI API key',
            message: 'Paid per use. Paste the key:',
            placeholder: 'sk-…',
            confirmLabel: 'Add',
          });
          if (key === null || key.trim() === '') return;
          await writeShared('add API key', () => api.addAccount('codex', { apiKey: key.trim() }));
        })()
      }
    >
      Add API key
    </button>
  );
}
