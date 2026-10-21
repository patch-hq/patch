// Usage → one provider's accounts (spec/10 § Backend credentials).
//
// The accounts are shared settings (spec/01 § Settings): one ordered list per
// provider, held on the server and sent to every host. Every change here is a
// server write and settles on its answer. A host is only ever the READER of an
// account — it takes the usage reading — and the freshest reading from any
// host is what is shown; which host took it is not something this page says,
// because an account belongs to nobody's machine.

import type { JSX, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { AccountStrategy, HostAccountSummary } from '@patch/wire';
import { api, type SharedBackendId } from '../../api/rest.js';
import { getActiveWs } from '../../api/ws.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { formatReadAt } from '../../lib/usage.js';
import { sortHosts } from './hostScope.js';
import { sendToHost } from './hostWrite.js';
import { writeShared } from './sharedWrite.js';
import { AccountRow, RankedList, UsageBars, type MenuItem } from './accountList.js';
import { Note, Pills, Row } from './ui.js';
import type { ProviderSpec, SharedRow } from './providers.js';

const STRATEGIES: readonly AccountStrategy[] = [
  'priority',
  'round-robin',
  'soonest-reset',
  'least-used',
];
const STRATEGY_LABELS: Record<AccountStrategy, string> = {
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
  const name = provider.name;
  const id = `${backendId}-${row.id}`;
  // Two rows on one Claude organisation are one pool of credit under two
  // labels: failover between them has nowhere to go, so it is said.
  const twin =
    row.organizationId === undefined
      ? undefined
      : rows.find((r) => r.id !== row.id && r.organizationId === row.organizationId);
  const readAt = formatReadAt(reading?.usage?.at);
  const sub = [
    row.email ?? null,
    row.connected ? null : 'Signed out',
    row.kind === 'apiKey' ? 'API key' : null,
    readAt,
  ].filter((x): x is string => x !== null);

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
    ...(provider.pasteToken
      ? [
          row.connected
            ? {
                label: 'Sign in again',
                detail: 'Replace the stored login with a fresh token',
                testid: `account-connect-${id}`,
                onSelect: () => pasteToken(`Sign in again to ${row.label}`, 'Sign in'),
              }
            : {
                label: 'Sign in',
                detail: 'Paste a token to start using this account',
                testid: `account-connect-${id}`,
                onSelect: () => pasteToken(`Sign in to ${row.label}`, 'Sign in'),
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
                  message: `Sign out of ${row.label}? Every machine stops using it until it is signed in again.`,
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
            message: `Remove ${row.label} from every machine? Its row goes too.`,
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
      <span className="set-row-title">{row.label}</span>
      {sub.length > 0 ? <span className="set-sub">{sub.join(' · ')}</span> : null}
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

/** Add a Claude account from a pasted `claude setup-token` token. */
export function AddClaudeAccount(): JSX.Element {
  return (
    <div className="set-inline set-add-bar start">
      <button
        type="button"
        className="set-btn"
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
        Add account
      </button>
    </div>
  );
}

/**
 * Add a ChatGPT account. A ChatGPT sign-in has to run on a machine — Codex
 * does the device flow — so one online host runs it and sends the login to
 * the server; which host is not the user's concern. An API key is added
 * straight to the server.
 */
export function AddChatGPTAccount(): JSX.Element {
  const hosts = usePresenceStore((s) => s.hosts);
  const requested = useUiStore((s) => s.codexSignInHost);
  const online = sortHosts(Object.values(hosts)).filter((h) => h.online);
  const [hostId, setHostId] = useState<string | null>(null);
  useEffect(() => {
    if (requested !== null) setHostId(requested);
  }, [requested]);
  const host = online.find((h) => h.hostId === hostId) ?? online[0] ?? null;
  const login = host?.accounts['codex']?.login;
  const pending = login?.status === 'pending';

  const send = (authMethod: 'device' | 'browser' | 'cancel', requestId?: string): void => {
    if (!host) return;
    setHostId(host.hostId);
    const ws = getActiveWs();
    if (!ws) {
      useUiStore.getState().pushError('sign in: this surface has no link to the server');
      return;
    }
    sendToHost(host, {
      type: 'host.backend_add_account',
      hostId: host.hostId,
      backendId: 'codex',
      authMethod,
      requestId: requestId ?? `signin-${Date.now()}`,
    });
  };

  return (
    <div className="set-add-bar start stack" data-testid="add-chatgpt-account">
      <div className="set-inline">
        <button
          type="button"
          className="set-btn"
          data-testid="chatgpt-signin"
          disabled={host === null || pending}
          onClick={() => send('device')}
        >
          Sign in with ChatGPT
        </button>
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
              await writeShared('add API key', () =>
                api.addAccount('codex', { apiKey: key.trim() }),
              );
            })()
          }
        >
          Add API key
        </button>
      </div>
      {host === null ? <Note testid="chatgpt-no-host">Connect a machine to sign in</Note> : null}
      {pending && login ? (
        <div className="set-inline" role="status" data-testid="chatgpt-login-pending">
          <span className="set-row-title">Waiting for sign-in…</span>
          {login.code ? <code className="set-code">{login.code}</code> : null}
          {login.url ? (
            <a className="set-btn" href={login.url} target="_blank" rel="noreferrer">
              Open sign-in
            </a>
          ) : null}
          <button
            type="button"
            className="set-btn ghost"
            onClick={() => send('cancel', login.requestId)}
          >
            Cancel sign-in
          </button>
        </div>
      ) : null}
      {login?.status === 'failed' && login.error ? (
        <p className="set-error" role="alert">
          {login.error}
        </p>
      ) : null}
    </div>
  );
}
