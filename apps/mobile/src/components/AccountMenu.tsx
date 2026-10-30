// The composer's account picker (spec/15 § Composer → Account): each connected
// account of the model's provider with its 5-hour and weekly usage beside it,
// plus "By strategy". Mounted only while open, so the usage reads it triggers
// happen on demand.

import React from 'react';
import { AnchoredMenu } from './AnchoredMenu';
import { usageSummary, useAccountUsage } from '../lib/useAccountUsage';

export function AccountMenu({
  visible,
  backendId,
  selectedId,
  strategySelected,
  onSelect,
  onDismiss,
}: {
  visible: boolean;
  /** Only this provider's accounts can run the chat's model. */
  backendId: string;
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
      selectedId={selectedId}
      strategySelected={strategySelected}
      onSelect={onSelect}
      onDismiss={onDismiss}
    />
  );
}

function AccountMenuItems({
  backendId,
  selectedId,
  strategySelected,
  onSelect,
  onDismiss,
}: Omit<Parameters<typeof AccountMenu>[0], 'visible'>): React.ReactElement {
  const rows = useAccountUsage().filter((r) => r.backendId === backendId);
  return (
    <AnchoredMenu
      visible
      items={[
        ...rows.map((r) => ({
          id: r.id,
          label: r.label,
          detail: usageSummary(r.usage),
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
