// UsagePopover — every usage figure in one place (spec/14 § Usage popover):
// the open chat's context window, then each connected account's limit windows
// on every host, drawn with the same bars the Usage settings page uses.
//
// Opened from two triggers — the context ring beside Send and the usage crumb
// in the chat header — so it is portalled to the body and positioned from the
// trigger's measured rect: the header's crumb zone is `overflow: hidden`, and
// an in-flow pop-up there is clipped (see ModelPicker for the same fix).

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { CLAUDE_BACKEND_ID, type ChatContextUsage } from '@patch/wire';
import { usePresenceStore, type HostAccount } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { UsageBars } from '../routes/settings/accountList.js';
import { formatReadAt, summariseContext } from '../lib/usage.js';

const BACKEND_LABEL: Record<string, string> = { [CLAUDE_BACKEND_ID]: 'Claude', codex: 'OpenAI' };

export interface AccountUsageRow {
  key: string;
  /** The provider the account belongs to (`claude`, `codex`). */
  providerId: 'claude' | 'codex';
  /** The shared account's id. */
  accountId: string;
  /** The account's own label, without the backend prefix. */
  label: string;
  /** The backend's name in words — `Claude`, `OpenAI`. */
  backend: string;
  title: string;
  usage: HostAccount['usage'];
}

/** Each shared subscription account once; hosts only supply its usage readings. */
export function accountRows(
  hosts: ReturnType<typeof usePresenceStore.getState>['hosts'],
  shared: ReturnType<typeof usePreferencesStore.getState>['shared'],
): AccountUsageRow[] {
  if (shared === null) return [];
  const rows: AccountUsageRow[] = [];
  const backends = [
    { id: CLAUDE_BACKEND_ID, providerId: 'claude', accounts: shared.secrets.claude },
    { id: 'codex', providerId: 'codex', accounts: shared.secrets.codex },
  ] as const;
  for (const { id: backendId, providerId, accounts } of backends) {
    const backend = BACKEND_LABEL[backendId] ?? backendId;
    for (const account of accounts) {
      if (!account.connected || ('kind' in account && account.kind === 'apiKey')) continue;
      let usage: HostAccount['usage'];
      let readAt = -1;
      for (const host of Object.values(hosts)) {
        const summary = host.accounts[backendId]?.accounts?.find((a) => a.id === account.id);
        const at = summary?.usage?.at ?? 0;
        if (summary?.usage && at > readAt) {
          usage = summary.usage;
          readAt = at;
        }
      }
      rows.push({
        key: `${backendId}:${account.id}`,
        providerId,
        accountId: account.id,
        label: account.label,
        backend,
        title: `${backend} · ${account.label}`,
        usage,
      });
    }
  }
  return rows;
}

export function UsagePopover({
  anchorRef,
  direction,
  align,
  context,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  direction: 'up' | 'down';
  align: 'start' | 'end';
  /** The open chat's reading; omitted where there is no chat. */
  context?: ChatContextUsage | null;
  onClose: () => void;
}): JSX.Element | null {
  const hosts = usePresenceStore((s) => s.hosts);
  const shared = usePreferencesStore((s) => s.shared);
  const rows = accountRows(hosts, shared);
  const ctx = summariseContext(context);
  const popRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    function measure(): void {
      const el = anchorRef.current;
      if (el) setRect(el.getBoundingClientRect());
    }
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    function onDown(e: PointerEvent): void {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  if (rect === null) return null;
  const margin = 8;
  const style: CSSProperties = {
    position: 'fixed',
    ...(direction === 'down'
      ? { top: rect.bottom + 6, maxHeight: window.innerHeight - rect.bottom - 6 - margin }
      : { bottom: window.innerHeight - rect.top + 6, maxHeight: rect.top - 6 - margin }),
    ...(align === 'start'
      ? { left: Math.max(margin, rect.left) }
      : { right: Math.max(margin, window.innerWidth - rect.right) }),
  };

  return createPortal(
    <div
      ref={popRef}
      className="usage-pop"
      role="dialog"
      aria-label="Usage"
      data-testid="usage-popover"
      style={style}
    >
      {ctx ? (
        <section className="usage-pop-section" data-testid="usage-pop-context">
          <h4>Context</h4>
          <div className="set-bars">
            <div
              className={`set-bar-row${ctx.level === 'ok' || ctx.level === 'unknown' ? '' : ` ${ctx.level === 'blocked' ? 'blocked' : 'warn'}`}`}
            >
              <span className="set-bar-label">Window</span>
              <span className="set-bar" aria-hidden="true">
                <i style={{ width: `${Math.round(ctx.fraction * 100)}%` }} />
              </span>
              <span className="set-bar-value">{ctx.percent}</span>
              <span className="set-bar-reset">{ctx.tokens}</span>
            </div>
          </div>
        </section>
      ) : null}
      {rows.map((r) => {
        const readAt = formatReadAt(r.usage?.at);
        return (
          <section className="usage-pop-section" key={r.key} data-testid="usage-pop-account">
            <h4>{r.title}</h4>
            {readAt ? <span className="set-sub usage-pop-read-at">{readAt}</span> : null}
            <UsageBars
              usage={r.usage}
              testId={`usage-pop-bars-${r.key}`}
              testIdFor={(scope) => `usage-pop-${scope}-${r.key}`}
            />
          </section>
        );
      })}
      <Link className="usage-pop-link" to="/settings/usage" onClick={onClose}>
        Settings
      </Link>
    </div>,
    document.body,
  );
}
