// The composer's account picker (spec/15 § Composer → Account): each connected
// account of the model's provider with its 5-hour and weekly usage beside it
// (a Bedrock account, only on its own host, with its monthly spend instead),
// plus "By strategy". Mounted only while open, so the usage reads it triggers
// happen on demand.

import React from 'react';
import { describeAccountState, lockableAccounts, parseAcpModel } from '@patch/wire';
import { AnchoredMenu } from './AnchoredMenu';
import { usageSummary, useAccountUsage } from '../lib/useAccountUsage';
import { formatReset } from '../lib/usage';
import { bedrockSpend } from '../lib/bedrock';
import { useSettingsStore } from '../stores/settingsStore';

export function AccountMenu({
  visible,
  backendId,
  model,
  hostId,
  selectedId,
  strategySelected,
  onSelect,
  onDismiss,
}: {
  visible: boolean;
  /** Only this provider's accounts can run the chat's model. */
  backendId: string;
  /** The chat's model: an ACP agent's chat runs on that agent's accounts only. */
  model?: string | null | undefined;
  /** The chat's host: a Bedrock account is offered only for a chat on its own host. */
  hostId: string | null;
  /** The account in force, if any. */
  selectedId: string | null;
  /** Whether "By strategy" is the ticked row. */
  strategySelected: boolean;
  /** `null` is "By strategy". */
  onSelect: (accountId: string | null) => void;
  onDismiss: () => void;
}): React.ReactElement | null {
  if (!visible) return null;
  return (
    <AccountMenuItems
      backendId={backendId}
      model={model}
      hostId={hostId}
      selectedId={selectedId}
      strategySelected={strategySelected}
      onSelect={onSelect}
      onDismiss={onDismiss}
    />
  );
}

function AccountMenuItems({
  backendId,
  model,
  hostId,
  selectedId,
  strategySelected,
  onSelect,
  onDismiss,
}: Omit<Parameters<typeof AccountMenu>[0], 'visible'>): React.ReactElement {
  const usageRows = useAccountUsage().filter(
    (r) => r.backendId === backendId && (r.bedrock === undefined || r.bedrock.hostId === hostId),
  );
  const secrets = useSettingsStore((s) => s.data?.shared?.secrets);
  // An ACP agent's accounts carry no usage windows: each shows its state.
  const rows = parseAcpModel(model)
    ? lockableAccounts(secrets, model).map((a) => ({
        id: a.id,
        label: a.label,
        detail: a.state ? describeAccountState(a.state, (at) => formatReset(at)) : 'API key',
      }))
    : usageRows.map((r) => ({
        id: r.id,
        label: r.label,
        // A Bedrock account has its monthly spend in place of the windows.
        detail: r.bedrock
          ? `${bedrockSpend(r.bedrock)} this month · estimated`
          : usageSummary(r.usage),
      }));
  return (
    <AnchoredMenu
      visible
      items={[
        ...rows.map((r) => ({
          id: r.id,
          label: r.label,
          detail: r.detail,
          testID: `account-option-${r.id}`,
          selected: r.id === selectedId,
        })),
        {
          id: '',
          label: 'By strategy',
          testID: 'account-option-strategy',
          selected: strategySelected,
        },
      ]}
      onSelect={(id) => onSelect(id === '' ? null : id)}
      onDismiss={onDismiss}
      placement="bottom"
    />
  );
}
