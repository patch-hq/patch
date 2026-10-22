// AccountUsageStrip — the new-chat screen's usage block (spec/14 §8 § New-chat
// setup row): one read-only card per connected subscription account, beneath
// the selections and apart from them, so the account a chat will draw on is
// chosen with its headroom in view without the figures being the control.
//
// Two meters a card — the 5-hour window and the week — each a bar WITH the
// figure said in words (`79% used · resets 14:00`). It used to be one line of
// abbreviations (`5h 55% · wk 12%`), which did not say whether 55% was used or
// left. A window the host has not reported is said to be missing rather than
// drawn as an empty bar, and an account nothing has read yet says so.
//
// Four accounts show at once; more are a page away, so the block keeps one
// height however many accounts are connected.

import { Fragment, useState, type JSX } from 'react';
import { rateLimitWindowState } from '@patch/wire';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { accountRows, type AccountUsageRow } from './UsagePopover.js';
import { formatReset } from '../lib/usage.js';

/** How many accounts show at once; the rest are a page away. */
export const USAGE_PAGE_SIZE = 4;

const METERS: { scope: 'session' | 'week'; label: string }[] = [
  { scope: 'session', label: '5-hour' },
  { scope: 'week', label: 'Week' },
];

export function AccountUsageStrip(): JSX.Element | null {
  const hosts = usePresenceStore((s) => s.hosts);
  const shared = usePreferencesStore((s) => s.shared);
  const rows = accountRows(hosts, shared);
  const [page, setPage] = useState(0);
  if (rows.length === 0) return null;
  const pages = Math.ceil(rows.length / USAGE_PAGE_SIZE);
  // An account disconnected while a later page was showing: stay on a real one.
  const current = Math.min(page, pages - 1);
  const first = current * USAGE_PAGE_SIZE;
  const shown = rows.slice(first, first + USAGE_PAGE_SIZE);
  return (
    <section className="new-chat-usage" data-testid="new-chat-usage" aria-label="Usage">
      <div className="new-chat-usage-head">
        <h3 className="new-chat-usage-title">Usage</h3>
        {pages > 1 ? (
          <div className="new-chat-usage-pager" data-testid="new-chat-usage-pager">
            <button
              type="button"
              aria-label="Previous accounts"
              data-testid="new-chat-usage-prev"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              ‹
            </button>
            <span data-testid="new-chat-usage-page">
              {first + 1}–{first + shown.length} of {rows.length}
            </span>
            <button
              type="button"
              aria-label="Next accounts"
              data-testid="new-chat-usage-next"
              disabled={current === pages - 1}
              onClick={() => setPage(current + 1)}
            >
              ›
            </button>
          </div>
        ) : null}
      </div>
      <div className="new-chat-usage-grid">
        {shown.map((r) => (
          <UsageCard key={r.key} row={r} />
        ))}
      </div>
    </section>
  );
}

function UsageCard({ row }: { row: AccountUsageRow }): JSX.Element {
  return (
    <div className="new-chat-usage-card" data-testid={`new-chat-usage-${row.key}`}>
      <div className="new-chat-usage-name">
        <span>{row.label}</span>
        <span className="new-chat-usage-backend">{row.backend}</span>
      </div>
      {row.usage === undefined ? (
        <p className="new-chat-usage-empty">not read yet</p>
      ) : (
        <div className="new-chat-usage-meters">
          {METERS.map(({ scope, label }) => {
            const win = row.usage?.[scope];
            if (win === undefined) {
              return (
                <Fragment key={scope}>
                  <span className="new-chat-usage-label">{label}</span>
                  <span
                    className="new-chat-usage-fig new-chat-usage-missing"
                    data-testid={`new-chat-usage-${row.key}-${scope}`}
                  >
                    not reported
                  </span>
                </Fragment>
              );
            }
            const state = rateLimitWindowState(scope, win);
            const pct = Math.round((win.utilization ?? 0) * 100);
            const figure =
              win.utilization === undefined
                ? win.status === 'rejected'
                  ? 'blocked'
                  : 'no figure'
                : `${pct}% used${state === 'blocked' ? ' · blocked' : ''}`;
            const reset =
              win.resetsAt !== undefined ? ` · resets ${formatReset(win.resetsAt)}` : '';
            return (
              <Fragment key={scope}>
                <span className="new-chat-usage-label">{label}</span>
                <span className={`new-chat-usage-bar ${state}`} aria-hidden="true">
                  <i style={{ width: `${pct}%` }} />
                </span>
                <span
                  className="new-chat-usage-fig"
                  data-testid={`new-chat-usage-${row.key}-${scope}`}
                >
                  {figure}
                  {reset}
                </span>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
