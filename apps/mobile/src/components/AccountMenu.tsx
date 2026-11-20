// The composer's account picker (spec/15 § Composer → Account): each connected
// account of the model's provider with its 5-hour and weekly usage beside it,
// plus "By strategy". Mounted only while open, so the usage reads it triggers
// happen on demand.

import React from 'react';
import { describeAccountState, lockableAccounts, parseAcpModel } from '@patch/wire';
import { AnchoredMenu } from './AnchoredMenu';
import { usageSummary, useAccountUsage } from '../lib/useAccountUsage';
import { formatReset } from '../lib/usage';
import { useSettingsStore } from '../stores/settingsStore';

export function AccountMenu({
  visible,
  backendId,
  model,
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
  selectedId,
  strategySelected,
  onSelect,
  onDismiss,
}: Omit<Parameters<typeof AccountMenu>[0], 'visible'>): React.ReactElement {
  const usageRows = useAccountUsage().filter((r) => r.backendId === backendId);
  const secrets = useSettingsStore((s) => s.data?.shared?.secrets);
  // An ACP agent's accounts carry no usage windows: each shows its state.
  const rows = parseAcpModel(model)
    ? lockableAccounts(secrets, model).map((a) => ({
        id: a.id,
        label: a.label,
        detail: a.state ? describeAccountState(a.state, (at) => formatReset(at)) : 'API key',
      }))
    : usageRows.map((r) => ({ id: r.id, label: r.label, detail: usageSummary(r.usage) }));
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
