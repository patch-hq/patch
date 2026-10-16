// AccountUsageStrip — one compact usage indicator per connected subscription
// account (spec/14 § New-chat setup row), so the account a new chat will draw
// on is chosen with its headroom in view. Same readings as the usage popover.

import type { JSX } from 'react';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { accountRows } from './UsagePopover.js';
import { formatUtilization } from '../lib/usage.js';

export function AccountUsageStrip(): JSX.Element | null {
  const hosts = usePresenceStore((s) => s.hosts);
  const shared = usePreferencesStore((s) => s.shared);
  const rows = accountRows(hosts, shared);
  if (rows.length === 0) return null;
  return (
    <div className="new-chat-usage" data-testid="new-chat-usage">
      {rows.map((r) => (
        <span className="new-chat-usage-item" key={r.key} data-testid={`new-chat-usage-${r.key}`}>
          <span className="new-chat-usage-name">{r.title}</span>
          {r.usage === undefined ? (
            <span className="new-chat-usage-fig">not read yet</span>
          ) : (
            <span className="new-chat-usage-fig">
              5h {formatUtilization(r.usage.session)} · wk {formatUtilization(r.usage.week)}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
