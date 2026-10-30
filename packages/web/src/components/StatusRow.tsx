// StatusRow — the one row anatomy shared by every bar under the chat header
// (spec/14 § Main chat panel — Status list): icon | label | content | meta |
// action. Goal, Agents, Tasks and Artifacts all draw through it so they read as
// one list rather than four separately styled bars.

import { type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export interface StatusRowProps {
  /** 16px leading icon; omitted on rows nested under a folded group. */
  icon?: ReactNode;
  /** Fixed-width label word (Goal / Agents / Tasks / Artifacts). Hidden on a phone. */
  label?: string;
  children: ReactNode;
  /** Right-aligned time or secondary detail. Hidden on a phone when `quietMeta`. */
  meta?: ReactNode;
  quietMeta?: boolean;
  /** The action column: only ever a close or kill button. */
  action?: ReactNode;
  testId?: string;
  className?: string;
  /** Items listed under a folded row sit under the content column, without icon or label. */
  nested?: boolean;
  /** Content wraps instead of ellipsising (an opened goal). */
  wrap?: boolean;
  /** Muted detail line under the content column (an opened row, or a note that needs the user). */
  sub?: ReactNode;
  role?: string;
  /** Makes the whole row a button (opening a transcript or terminal). */
  onActivate?: () => void;
  activateLabel?: string;
  [dataAttr: `data-${string}`]: string | undefined;
}

export function StatusRow({
  icon,
  label,
  children,
  meta,
  quietMeta,
  action,
  testId,
  className,
  nested,
  wrap,
  sub,
  onActivate,
  activateLabel,
  ...rest
}: StatusRowProps): JSX.Element {
  const cls = [
    'status-row',
    nested ? 'status-row-nested' : '',
    wrap ? 'status-row-wrap' : '',
    className ?? '',
  ]
    .filter((c) => c !== '')
    .join(' ');
  return (
    <div
      className={cls}
      data-testid={testId}
      {...(onActivate
        ? {
            role: 'button',
            tabIndex: 0,
            'aria-label': activateLabel,
            title: activateLabel,
            onClick: onActivate,
            onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
              if (e.target !== e.currentTarget) return;
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              onActivate();
            },
          }
        : {})}
      {...rest}
    >
      <span className="status-row-icon">{icon}</span>
      <span className="status-row-label">{label}</span>
      <span className="status-row-content">{children}</span>
      <span className={`status-row-meta${quietMeta ? ' status-row-meta-quiet' : ''}`}>{meta}</span>
      <span className="status-row-action">{action}</span>
      {sub ? <div className="status-row-sub">{sub}</div> : null}
    </div>
  );
}

/** The folded row's leading count/status: a small pill button that opens and closes the group. */
export function StatusPill({
  children,
  open,
  onToggle,
  testId,
  label,
}: {
  children: ReactNode;
  open: boolean;
  onToggle: () => void;
  testId?: string;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className="status-pill"
      data-testid={testId}
      aria-expanded={open}
      aria-label={label}
      onClick={onToggle}
    >
      {children}
      {open ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
    </button>
  );
}
