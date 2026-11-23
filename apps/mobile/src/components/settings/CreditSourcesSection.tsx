// Settings → Usage (design/settings-redesign; spec/10 § Backend credentials):
// the Claude and ChatGPT accounts every host draws from — each list ranked,
// with the strategy that picks among them, each account's freshest usage
// reading from any host, and a ⋯ of actions — and whether a turn stopped by a
// limit resumes on its own.
//
// The accounts are shared settings (spec/01 § Settings): every change is a
// server write that settles on the committed state, and none needs any
// particular host online. A ChatGPT sign-in is the one thing that runs on a
// host, since Codex does the device flow; its login then goes to the server.

import React from 'react';
import { Alert, View } from 'react-native';
import { describeAccountState, type ClaudeBedrock, type HostAccountSummary } from '@patch/wire';
import { api, type SharedBackendId } from '../../api/rest';
import { space } from '../../lib/theme';
import { formatReset } from '../../lib/usage';
import { usePresenceStore } from '../../stores/presenceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { AnchoredMenuItem } from '../AnchoredMenu';
import { SettingsSection } from '../SettingsSection';
import {
  STRATEGIES,
  STRATEGY_HINT,
  STRATEGY_LABEL,
  moveAccount,
  moveItems,
  Rank,
  RenameEntry,
  RowMenu,
  TokenEntry,
  UsageBars,
} from './accountRows';
import { NoticeRow } from './HostSwitcher';
import { SettingsPage } from './SettingsPage';
import { UsageHistorySection } from './UsageHistorySection';
import { AcpAccountsSections } from './AcpAccountsSection';
import { AutoCheckbox, BedrockForm, BedrockLines, BedrockTag } from './bedrock';
import { PROVIDERS, type ProviderSpec, type SharedRow } from './providers';
import { writeShared } from './sharedWrite';
import { Chips, ErrorLine, Muted, Row } from './ui';

export { CLAUDE_ACK_TIMEOUT_MS } from './accountRows';

export { STRATEGY_HINT } from './accountRows';

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
          <AcpAccountsSections />
        </>
      )}
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
  // Accounts with auto off sit after the others with no position in the order
  // (spec/10 § Choosing an account); only the ranked ones move.
  const ranked = rows.filter((r) => !isOutOfOrder(provider, r));
  const unranked = rows.filter((r) => isOutOfOrder(provider, r));
  const move = (index: number, dir: -1 | 1): void => {
    setMoving(true);
    void writeShared('Reorder', () =>
      api.orderAccounts(backendId, [
        ...moveAccount(
          ranked.map((r) => r.id),
          index,
          dir,
        ),
        ...unranked.map((r) => r.id),
      ]),
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
        <>
          {provider.autoFlag ? <AutoHeader testID={`accounts-header-${backendId}`} /> : null}
          {ranked.map((row, i) => (
            <AccountRow
              key={row.id}
              provider={provider}
              row={row}
              rows={rows}
              rank={i + 1}
              rankedCount={ranked.length}
              moving={moving}
              onMove={(dir) => move(i, dir)}
            />
          ))}
          {unranked.map((row) => (
            <AccountRow
              key={row.id}
              provider={provider}
              row={row}
              rows={rows}
              rank={null}
              rankedCount={ranked.length}
              moving={moving}
              onMove={() => undefined}
            />
          ))}
        </>
      )}
    </SettingsSection>
  );
}

/** Whether a row sits out of the order: its provider carries `auto` and it is off. */
function isOutOfOrder(provider: ProviderSpec, row: SharedRow): boolean {
  return provider.autoFlag && 'auto' in row && row.auto === false;
}

/** The header over a list whose rows start with their Auto checkbox. */
function AutoHeader({ testID }: { testID: string }): React.ReactElement {
  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        gap: space.md,
        paddingHorizontal: space.md + 2,
        paddingTop: space.sm,
      }}
    >
      <Muted>Auto</Muted>
      <Muted>Account</Muted>
    </View>
  );
}

function AccountRow({
  provider,
  row,
  rows,
  rank,
  rankedCount,
  moving,
  onMove,
}: {
  provider: ProviderSpec;
  row: SharedRow;
  rows: readonly SharedRow[];
  /** Its place in the order; null for an account with auto off. */
  rank: number | null;
  rankedCount: number;
  moving: boolean;
  onMove: (dir: -1 | 1) => void;
}): React.ReactElement {
  const backendId = provider.id;
  const reading = useReading(backendId, row.id);
  const [connecting, setConnecting] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const id = `${backendId}-${row.id}`;
  const bedrock = 'bedrock' in row ? row.bedrock : undefined;
  if (bedrock) {
    return (
      <BedrockRow
        row={row}
        bedrock={bedrock}
        id={id}
        rank={rank}
        rankedCount={rankedCount}
        moving={moving}
        onMove={onMove}
        editing={editing}
        setEditing={setEditing}
      />
    );
  }
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
    row.state ? describeAccountState(row.state, formatReset) : null,
    'kind' in row && row.kind === 'apiKey' ? 'API key' : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');

  const items: AnchoredMenuItem[] = [
    ...(rank === null ? [] : moveItems(`account-${id}`, rank - 1, rankedCount, moving)),
    {
      id: 'rename',
      label: 'Rename',
      detail: 'Change the name shown in the list',
      testID: `account-${id}-rename`,
    },
    // A provider with no token to paste signs a row in with its own flow; an
    // API-key row has nothing to sign in to.
    ...(!provider.pasteToken && !('kind' in row && row.kind === 'apiKey')
      ? [
          {
            id: 'connect',
            label: row.connected ? 'Sign in again' : 'Sign in',
            detail: provider.signInDetail,
            testID: `account-${id}-connect`,
          },
        ]
      : []),
    ...(provider.pasteToken
      ? [
          {
            id: 'connect',
            label: row.connected ? 'Sign in again' : 'Sign in',
            detail: row.connected
              ? 'Replace the stored login with a fresh token'
              : 'Paste a token to start using this account',
            testID: `account-${id}-connect`,
          },
        ]
      : []),
    ...(row.connected
      ? [
          {
            id: 'disconnect',
            label: 'Sign out',
            detail: 'Keep the row, forget the login: nothing uses it until it is signed in again',
            testID: `account-${id}-disconnect`,
            destructive: true,
          },
        ]
      : []),
    {
      id: 'remove',
      label: 'Remove',
      detail: 'Forget this account everywhere',
      testID: `account-${id}-remove`,
      destructive: true,
    },
  ];

  const onSelect = (action: string): void => {
    if (action === 'up') onMove(-1);
    else if (action === 'down') onMove(1);
    else if (action === 'rename') setRenaming(true);
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
          text: 'Remove',
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
        leading={<Leading provider={provider} row={row} id={id} rank={rank} />}
        right={
          <RowMenu
            testID={`account-${id}-menu`}
            label={row.label}
            items={items}
            onSelect={onSelect}
          />
        }
      />
      {/* Lined up with the row's own text rather than the card's edge. */}
      <View style={{ paddingHorizontal: space.md + 2 }}>
        {twin ? (
          <Muted testID={`account-${id}-twin`}>
            Same {provider.name} account as {twin.label}
          </Muted>
        ) : null}
        {reading?.error ? (
          <ErrorLine testID={`account-${id}-error`} message={reading.error} />
        ) : null}
        <UsageBars
          usage={reading?.usage}
          testID={`account-${id}-usage`}
          refreshing={false}
          scopes={provider.windows}
          extraUsageUrl={provider.extraUsageUrl}
        />
      </View>
      {renaming ? (
        <RenameEntry
          testID={`account-${id}-rename`}
          current={row.label}
          onSubmit={(label) => {
            if (label === '') return;
            void writeShared('Rename', () => api.updateAccount(backendId, row.id, { label })).then(
              (ok) => {
                if (ok) setRenaming(false);
              },
            );
          }}
        />
      ) : null}
      {connecting ? (
        <provider.SignInFlow accountId={row.id} onDone={() => setConnecting(false)} />
      ) : null}
      {connecting && provider.pasteToken ? (
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

/**
 * What a row starts with: on a provider whose accounts carry `auto`, the Auto
 * checkbox, then its rank while it is in the order (an account with auto off
 * has none).
 */
function Leading({
  provider,
  row,
  id,
  rank,
}: {
  provider: ProviderSpec;
  row: SharedRow;
  id: string;
  rank: number | null;
}): React.ReactElement {
  if (!provider.autoFlag) return <Rank n={rank ?? 0} active={false} />;
  const auto = !('auto' in row && row.auto === false);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <AutoCheckbox
        testID={`account-${id}-auto`}
        label={`Switch to ${row.label} automatically`}
        checked={auto}
        onChange={(next) =>
          void writeShared('Auto', () => api.updateAccount(provider.id, row.id, { auto: next }))
        }
      />
      {rank === null ? <View style={{ width: 22 }} /> : <Rank n={rank} active={false} />}
    </View>
  );
}

/**
 * A Claude on Amazon Bedrock row (spec/10 § Settings): its label with a
 * `Bedrock` tag, the labelled Host / AWS profile / Region / Monthly / Spent
 * lines, and a ⋯ of Edit and Remove. Patch has no sign-in for it: signing in
 * to the profile is AWS's own.
 */
function BedrockRow({
  row,
  bedrock,
  id,
  rank,
  rankedCount,
  moving,
  onMove,
  editing,
  setEditing,
}: {
  row: SharedRow;
  bedrock: ClaudeBedrock;
  id: string;
  rank: number | null;
  rankedCount: number;
  moving: boolean;
  onMove: (dir: -1 | 1) => void;
  editing: boolean;
  setEditing: (on: boolean) => void;
}): React.ReactElement {
  const provider = PROVIDERS.find((p) => p.id === 'claude-code')!;
  const signedOut = !row.connected;
  // Signed out has its own Status line; any other state but Ready is said under the label.
  const state =
    row.state && row.state.state !== 'ready' && row.state.state !== 'signed_out'
      ? describeAccountState(row.state, formatReset)
      : undefined;
  const items: AnchoredMenuItem[] = [
    ...(rank === null ? [] : moveItems(`account-${id}`, rank - 1, rankedCount, moving)),
    { id: 'edit', label: 'Edit', testID: `account-${id}-edit` },
    { id: 'remove', label: 'Remove', testID: `account-${id}-remove`, destructive: true },
  ];
  const onSelect = (action: string): void => {
    if (action === 'up') onMove(-1);
    else if (action === 'down') onMove(1);
    else if (action === 'edit') setEditing(true);
    else if (action === 'remove') {
      Alert.alert(`Remove ${row.label}?`, 'The account is forgotten everywhere.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => void writeShared('Remove', () => api.removeAccount('claude-code', row.id)),
        },
      ]);
    }
  };
  return (
    <View testID={`account-${id}`} style={{ paddingVertical: space.xs }}>
      <Row
        title={row.label}
        subtitle={state}
        leading={<Leading provider={provider} row={row} id={id} rank={rank} />}
        right={
          <>
            <BedrockTag testID={`account-${id}-tag`} />
            <RowMenu
              testID={`account-${id}-menu`}
              label={row.label}
              items={items}
              onSelect={onSelect}
            />
          </>
        }
      />
      <View style={{ paddingHorizontal: space.md + 2 }}>
        <BedrockLines bedrock={bedrock} signedOut={signedOut} testID={`account-${id}-bedrock`} />
        {editing ? (
          <BedrockForm
            testID={`account-${id}-form`}
            editing={{
              accountId: row.id,
              initial: {
                label: row.label,
                auto: !('auto' in row && row.auto === false),
                hostId: bedrock.hostId,
                awsProfile: bedrock.awsProfile,
                awsRegion: bedrock.awsRegion,
                regionPrefix: bedrock.regionPrefix,
                monthlyCapUsd: bedrock.monthlyCapUsd,
              },
            }}
            onDone={() => setEditing(false)}
          />
        ) : null}
      </View>
    </View>
  );
}
