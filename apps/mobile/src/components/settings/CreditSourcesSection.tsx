// Settings → Usage (design/settings-redesign; spec/10 § Backend credentials):
// the Claude and ChatGPT accounts every host draws from — each list ranked,
// with the strategy that picks among them, each account's freshest usage
// reading from any host, and a ⋯ of actions — and whether a turn stopped by a
// limit resumes on its own.
//
// The accounts are shared settings (spec/01 § Settings): every change is a
// server write that settles on the committed state, and none needs any
// particular host online. A ChatGPT sign-in is the one thing that runs on a
// machine, since Codex does the device flow; its login then goes to the server.

import React from 'react';
import { Alert, View } from 'react-native';
import type { AccountStrategy, HostAccountSummary } from '@patch/wire';
import { api, type SharedBackendId } from '../../api/rest';
import { space } from '../../lib/theme';
import { usePresenceStore } from '../../stores/presenceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { AnchoredMenuItem } from '../AnchoredMenu';
import { SettingsSection } from '../SettingsSection';
import { moveAccount, moveItems, Rank, RowMenu, TokenEntry, UsageBars } from './accountRows';
import { NoticeRow } from './HostSwitcher';
import { SettingsPage } from './SettingsPage';
import { UsageHistorySection } from './UsageHistorySection';
import { PROVIDERS, type ProviderSpec, type SharedRow } from './providers';
import { patchShared, writeShared } from './sharedWrite';
import { Chips, ErrorLine, Muted, Row, ToggleRow, WithSettings } from './ui';

export { CLAUDE_ACK_TIMEOUT_MS } from './accountRows';

const STRATEGIES: readonly AccountStrategy[] = [
  'priority',
  'round-robin',
  'soonest-reset',
  'least-used',
];
const STRATEGY_LABEL: Record<AccountStrategy, string> = {
  priority: 'Priority',
  'round-robin': 'Round robin',
  'soonest-reset': 'Soonest reset',
  'least-used': 'Least used',
};
/** What each strategy does, in one sentence (spec/10 § Backend credentials). */
export const STRATEGY_HINT: Record<AccountStrategy, string> = {
  priority: 'The first account here that still has allowance',
  'round-robin': 'Each turn takes the next account along, spent evenly',
  'soonest-reset': 'The account whose weekly limit resets soonest',
  'least-used': 'The account with the most allowance left right now',
};

export function UsagePage(): React.ReactElement {
  const shared = useSettingsStore((s) => s.data?.shared ?? null);
  const error = useSettingsStore((s) => s.error);
  return (
    <SettingsPage title="Usage" testID="settings-page-usage">
      <UsageHistorySection />
      {shared === null ? (
        <SettingsSection title="Accounts">
          {error ? (
            <ErrorLine
              testID="usage-error"
              message={`Couldn’t load settings: ${error}`}
              onRetry={() => void useSettingsStore.getState().load()}
            />
          ) : (
            <NoticeRow testID="usage-loading" text="Settings haven’t loaded yet" />
          )}
        </SettingsSection>
      ) : (
        <>
          {PROVIDERS.map((p) => (
            <Accounts key={p.id} provider={p} rows={p.rows(shared.secrets)} />
          ))}
        </>
      )}
      <WithSettings testID="auto-resume">
        {(data) => (
          <SettingsSection testID="settings-auto-resume">
            <ToggleRow
              label="Resume automatically when a limit resets"
              testID="auto-resume-rate-limit"
              value={data.preferences.autoResumeRateLimit}
              onChange={(next) => void patchShared('Auto-resume', { autoResumeRateLimit: next })}
            />
          </SettingsSection>
        )}
      </WithSettings>
    </SettingsPage>
  );
}

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

/** One backend's shared accounts, ranked, with its strategy and a way to add one. */
function Accounts({
  provider,
  rows,
}: {
  provider: ProviderSpec;
  rows: readonly SharedRow[];
}): React.ReactElement {
  const backendId = provider.id;
  const strategy = useSettingsStore(
    (s) => s.data?.preferences.accountStrategy[provider.strategyKey],
  );
  const [moving, setMoving] = React.useState(false);
  const name = provider.name;
  const move = (index: number, dir: -1 | 1): void => {
    setMoving(true);
    void writeShared('Reorder', () =>
      api.orderAccounts(
        backendId,
        moveAccount(
          rows.map((r) => r.id),
          index,
          dir,
        ),
      ),
    ).finally(() => setMoving(false));
  };
  return (
    <SettingsSection title={name} testID={`accounts-${backendId}`} footer={<provider.AddAccount />}>
      <Row testID={`strategy-${backendId}`} title="Pick the account by" stack>
        <Chips
          options={STRATEGIES}
          selected={strategy ?? 'priority'}
          labelOf={(s) => STRATEGY_LABEL[s]}
          testIDPrefix={`strategy-${backendId}`}
          labelPrefix={`${name} strategy`}
          hintOf={(s) => STRATEGY_HINT[s]}
          onSelect={(s) =>
            void writeShared(`${name} strategy`, () => api.setAccountStrategy(backendId, s))
          }
        />
      </Row>
      {rows.length === 0 ? (
        <NoticeRow testID={`accounts-empty-${backendId}`} text={`No ${name} accounts yet`} />
      ) : (
        rows.map((row, i) => (
          <AccountRow
            key={row.id}
            provider={provider}
            row={row}
            rows={rows}
            rank={i + 1}
            moving={moving}
            onMove={(dir) => move(i, dir)}
          />
        ))
      )}
    </SettingsSection>
  );
}

function AccountRow({
  provider,
  row,
  rows,
  rank,
  moving,
  onMove,
}: {
  provider: ProviderSpec;
  row: SharedRow;
  rows: readonly SharedRow[];
  rank: number;
  moving: boolean;
  onMove: (dir: -1 | 1) => void;
}): React.ReactElement {
  const backendId = provider.id;
  const reading = useReading(backendId, row.id);
  const [connecting, setConnecting] = React.useState(false);
  const id = `${backendId}-${row.id}`;
  const organizationId = 'organizationId' in row ? row.organizationId : undefined;
  // Two rows on one Claude organisation are one pool of credit under two labels.
  const twin =
    organizationId === undefined
      ? undefined
      : rows.find(
          (r) => r.id !== row.id && 'organizationId' in r && r.organizationId === organizationId,
        );
  const subtitle = [
    row.email ?? null,
    row.connected ? null : 'Signed out',
    'kind' in row && row.kind === 'apiKey' ? 'API key' : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');

  const items: AnchoredMenuItem[] = [
    ...moveItems(`account-${id}`, rank - 1, rows.length, moving),
    ...(provider.pasteToken
      ? [
          {
            id: 'connect',
            label: row.connected ? 'Sign in again' : 'Sign in',
            testID: `account-${id}-connect`,
          },
        ]
      : []),
    ...(row.connected
      ? [
          {
            id: 'disconnect',
            label: 'Sign out',
            testID: `account-${id}-disconnect`,
            destructive: true,
          },
        ]
      : []),
    { id: 'remove', label: 'Remove account', testID: `account-${id}-remove`, destructive: true },
  ];

  const onSelect = (action: string): void => {
    if (action === 'up') onMove(-1);
    else if (action === 'down') onMove(1);
    else if (action === 'connect') setConnecting(true);
    else if (action === 'disconnect') {
      Alert.alert(
        `Sign out of ${row.label}?`,
        'Nothing uses it until it is signed in again. The account stays in the list.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Sign out',
            style: 'destructive',
            onPress: () =>
              void writeShared('Sign out', () => api.disconnectAccount(backendId, row.id)),
          },
        ],
      );
    } else if (action === 'remove') {
      Alert.alert(`Remove ${row.label}?`, 'The account and its login are forgotten.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove account',
          style: 'destructive',
          onPress: () => void writeShared('Remove', () => api.removeAccount(backendId, row.id)),
        },
      ]);
    }
  };

  return (
    <View testID={`account-${id}`} style={{ paddingVertical: space.xs }}>
      <Row
        title={row.label}
        subtitle={subtitle === '' ? undefined : subtitle}
        leading={<Rank n={rank} active={false} />}
        right={
          <RowMenu
            testID={`account-${id}-menu`}
            label={row.label}
            items={items}
            onSelect={onSelect}
          />
        }
      />
      {twin ? (
        <Muted testID={`account-${id}-twin`}>
          Same {provider.name} account as {twin.label}
        </Muted>
      ) : null}
      {reading?.error ? <ErrorLine testID={`account-${id}-error`} message={reading.error} /> : null}
      <UsageBars
        usage={reading?.usage}
        testID={`account-${id}-usage`}
        refreshing={false}
        scopes={provider.windows}
        extraUsageUrl={provider.extraUsageUrl}
      />
      {connecting ? (
        <TokenEntry
          testID={`account-${id}-token`}
          placeholder="sk-ant-oat01-…"
          submitLabel="Sign in"
          onSubmit={(token) => {
            if (token === '') return;
            void writeShared('Sign in', () => api.updateAccount(backendId, row.id, { token })).then(
              (ok) => {
                if (ok) setConnecting(false);
              },
            );
          }}
        />
      ) : null}
    </View>
  );
}
