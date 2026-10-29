// The pieces the Usage page's account lists share: the ranked, draggable list,
// the usage bars, and the ⋯ menu.
//
// An account list's ORDER is its priority (accountFailover.ts): under the
// priority strategy the first account with credit takes the turn. So the list
// is ranked, and dragging one row above another sends the whole new order to
// the server, which holds the accounts for every host (spec/01 § Settings).
// The order shown is always the committed one — a drag shows its result only
// until the server answers.

import type { JSX, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { rateLimitWindowState, type RateLimitWindow } from '@patch/wire';
import {
  OVERAGE_DISABLED_REASON,
  OVERAGE_ORG_DISABLED_REASON,
  SCOPE_ORDER,
  formatReset,
  formatResetDetail,
  formatUntil,
  formatUtilization,
  type UsageScope,
} from '../../lib/usage.js';

export interface RankedItem {
  id: string;
  render: (handle: ReactNode, rank: number) => ReactNode;
}

/**
 * A list whose order is the accounts' priority. `onCommit` writes a new order
 * and resolves once the server has answered, whatever it said; the list then
 * shows the committed order.
 */
export function RankedList({
  items,
  testid,
  onCommit,
}: {
  items: RankedItem[];
  testid: string;
  onCommit: (next: string[]) => Promise<boolean>;
}): JSX.Element {
  const reported = items.map((i) => i.id);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [pending, setPending] = useState<object | null>(null);
  const dragging = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const order = (draft ?? reported).filter((id) => reported.includes(id));
  const byId = new Map(items.map((i) => [i.id, i]));

  function commit(next: string[]): void {
    if (next.join('\n') === reported.join('\n')) {
      setDraft(null);
      return;
    }
    setDraft(next);
    setPending({});
    void onCommit(next).finally(() => {
      setPending(null);
      setDraft(null);
    });
  }

  function move(id: string, to: number): string[] {
    const without = order.filter((x) => x !== id);
    without.splice(Math.max(0, Math.min(to, without.length)), 0, id);
    return without;
  }

  return (
    <div className="set-ranked" data-testid={testid} data-pending={pending ? 'true' : undefined}>
      {order.map((id, index) => {
        const item = byId.get(id);
        if (!item) return null;
        const handle = (
          <button
            type="button"
            className="set-handle"
            aria-label={`Move ${index + 1} of ${order.length}`}
            title="Drag to reorder"
            data-testid={`${testid}-handle-${id}`}
            disabled={pending !== null}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
              e.preventDefault();
              const to = e.key === 'ArrowUp' ? index - 1 : index + 1;
              if (to < 0 || to >= order.length) return;
              commit(move(id, to));
            }}
          >
            ⠿
          </button>
        );
        return (
          <div
            key={id}
            className={`set-ranked-item${draggingId === id ? ' dragging' : ''}`}
            draggable={pending === null}
            data-testid={`${testid}-item-${id}`}
            onDragStart={(e) => {
              dragging.current = id;
              setDraggingId(id);
              e.dataTransfer?.setData('text/plain', id);
              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              const from = dragging.current;
              if (from === null) return;
              e.preventDefault();
              if (from === id) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const before = e.clientY < rect.top + rect.height / 2;
              const current = draft ?? reported;
              const targetIndex = current.indexOf(id);
              const without = current.filter((x) => x !== from);
              const at = without.indexOf(id) + (before ? 0 : 1);
              without.splice(at, 0, from);
              if (targetIndex !== -1 && without.join('\n') !== current.join('\n'))
                setDraft(without);
            }}
            onDrop={(e) => e.preventDefault()}
            onDragEnd={() => {
              const was = dragging.current;
              dragging.current = null;
              setDraggingId(null);
              if (was === null) return;
              commit(draft ?? reported);
            }}
          >
            {item.render(handle, index + 1)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One account row: handle, rank, body, and a ⋯ that opens the row's actions
 * in a small panel beside it. The panel floats over whatever is below rather
 * than pushing it down, so the list never jumps; it closes on a choice, a
 * click elsewhere, or Escape.
 */
export function AccountRow({
  handle,
  rank,
  active,
  children,
  menu,
  menuLabel,
  menuTestid,
  testid,
}: {
  handle: ReactNode;
  rank: number;
  active: boolean;
  children: ReactNode;
  menu: MenuItem[];
  menuLabel: string;
  menuTestid: string;
  testid: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className={`set-acct${active ? ' active' : ''}`} data-testid={testid}>
      {handle}
      <span className="set-rank" aria-label={active ? `rank ${rank}, in use` : `rank ${rank}`}>
        {rank}
      </span>
      <div className="set-acct-body">{children}</div>
      {menu.length > 0 ? (
        <div className="set-acct-more" ref={wrap}>
          <button
            type="button"
            className="set-btn ghost set-more"
            aria-label={`${menuLabel} actions`}
            aria-expanded={open}
            aria-haspopup="menu"
            data-testid={menuTestid}
            onClick={() => setOpen((v) => !v)}
          >
            ⋯
          </button>
          {open ? (
            <div className="set-acct-menu" role="menu" data-testid={`${menuTestid}-open`}>
              {menu.map((it) => (
                <button
                  key={it.testid}
                  type="button"
                  role="menuitem"
                  className={`set-acct-menu-item${it.danger ? ' danger' : ''}`}
                  disabled={it.disabled}
                  data-testid={it.testid}
                  onClick={() => {
                    setOpen(false);
                    it.onSelect();
                  }}
                >
                  <span className="set-acct-menu-label">{it.label}</span>
                  {it.detail ? <span className="set-acct-menu-detail">{it.detail}</span> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <span />
      )}
    </div>
  );
}

export interface MenuItem {
  label: string;
  /** One line under the label saying what the action does, where the label alone does not. */
  detail?: string;
  onSelect: () => void;
  testid: string;
  danger?: boolean;
  disabled?: boolean;
}

type Scope = UsageScope;
const SCOPE_LABELS: Record<Scope, string> = {
  session: '5-hour',
  week: 'Weekly',
  overage: 'Extra usage',
};

/**
 * An account's limit windows as bars: label, fill, percentage, reset.
 *
 * `windows` is what the provider reports, in order; a window the host has not
 * reported draws nothing rather than an empty bar. The same `rejected` means
 * two different things. On the session or the week it means work has stopped.
 * On overage it means the extra-usage add-on was never bought — permanently
 * true of a healthy account — so it draws in neutral styling and reads as off,
 * with where to turn it on in place of a reset time. `org_level_disabled`
 * means organisation policy prevents it and says so; any other reason is
 * shown raw rather than guessed at.
 */
export function UsageBars({
  usage,
  windows = SCOPE_ORDER,
  extraUsageUrl,
  testId,
  testIdFor,
}: {
  usage:
    | { session?: RateLimitWindow; week?: RateLimitWindow; overage?: RateLimitWindow; at?: number }
    | undefined;
  windows?: readonly Scope[];
  extraUsageUrl?: string;
  testId: string;
  testIdFor: (scope: Scope) => string;
}): JSX.Element {
  if (usage === undefined) {
    return (
      <div className="set-bars" data-testid={testId}>
        <span className="set-sub set-bars-empty" data-testid={`${testId}-empty`}>
          Usage not read yet
        </span>
      </div>
    );
  }
  return (
    <div className="set-bars" data-testid={testId}>
      {windows.map((scope) => {
        const win = usage[scope];
        if (!win) return null;
        const state = rateLimitWindowState(scope, win);
        const blocked = state === 'blocked';
        const off = state === 'off';
        const cls = state === 'ok' ? '' : ` ${state}`;
        return (
          <div
            key={scope}
            className={`set-bar-row${cls}`}
            data-testid={testIdFor(scope)}
            title={
              win.resetsAt !== undefined
                ? `${win.status} · resets ${formatResetDetail(win.resetsAt)} (${formatUntil(win.resetsAt)})`
                : win.status
            }
          >
            <span className="set-bar-label">{SCOPE_LABELS[scope]}</span>
            <span className="set-bar" aria-hidden="true">
              <i style={{ width: `${Math.round((win.utilization ?? 0) * 100)}%` }} />
            </span>
            <span className="set-bar-value">{off ? 'off' : formatUtilization(win)}</span>
            <span
              className="set-bar-reset"
              title={
                win.disabledReason !== undefined
                  ? describeDisabledReason(win.disabledReason)
                  : undefined
              }
            >
              {win.disabledReason !== undefined ? (
                <DisabledReason reason={win.disabledReason} extraUsageUrl={extraUsageUrl} />
              ) : win.resetsAt !== undefined ? (
                `${blocked ? 'blocked · ' : ''}resets ${formatReset(win.resetsAt)}`
              ) : blocked ? (
                'blocked'
              ) : scope === 'week' && win.utilization !== undefined && win.utilization < 0.05 ? (
                // No reset instant on a nearly empty week: the provider's date
                // slides until usage anchors it, so none is shown.
                'resets 7 days after next use'
              ) : (
                ''
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Anthropic's reason code in words, in the reset column of the window it is
 * about. `org_level_disabled_until` is the one that matters and the one that
 * read as an accusation: it does NOT mean money has been spent, and it does
 * not mean anyone switched anything off — the add-on was never taken out, so
 * the line says where to turn it on.
 */
/** The reason as plain words, for the hover title when the column clips it. */
function describeDisabledReason(reason: string): string {
  if (reason === OVERAGE_DISABLED_REASON) return 'Extra usage is off: turn it on at claude.ai';
  if (reason === OVERAGE_ORG_DISABLED_REASON) return 'Extra usage disabled by organisation';
  return reason;
}

function DisabledReason({
  reason,
  extraUsageUrl,
}: {
  reason: string;
  extraUsageUrl: string | undefined;
}): JSX.Element {
  if (reason === OVERAGE_DISABLED_REASON && extraUsageUrl !== undefined) {
    return (
      <a
        href={extraUsageUrl}
        target="_blank"
        rel="noreferrer"
        data-testid="account-extra-usage-settings"
      >
        Turn on ↗
      </a>
    );
  }
  if (reason === OVERAGE_DISABLED_REASON) return <>disabled</>;
  if (reason === OVERAGE_ORG_DISABLED_REASON) return <>disabled by organisation</>;
  return <>{reason}</>;
}
