// The "Change account" / "Change provider" control shared by the usage-limit
// card and the out-of-usage banner: a button that opens a menu of what the
// chat can move to, or sits disabled with the reason on hover.

import { useRef, useState, type JSX } from 'react';
import { useDismissOnClickOff } from '../lib/dismissOnClickOff.js';
import type { LimitControl } from '../lib/limitControls.js';

export function LimitMenu({
  kind,
  label,
  control,
  main = false,
  className,
  onOpen,
  choose,
}: {
  kind: 'account' | 'provider';
  label: string;
  control: LimitControl & { options: { id: string; label: string }[] };
  /** Draw as the filled button. */
  main?: boolean;
  /** Overrides the card's button styling. */
  className?: string;
  onOpen?: () => void;
  choose: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useDismissOnClickOff(open, [wrapRef], () => setOpen(false));
  return (
    <div className="limit-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className={className ?? (main ? 'limit-btn limit-btn-main' : 'limit-btn')}
        data-testid={`rate-limit-change-${kind}`}
        data-enabled={control.enabled ? 'true' : 'false'}
        aria-haspopup="menu"
        aria-expanded={open}
        {...(control.enabled ? {} : { 'aria-disabled': true, title: control.reason })}
        onClick={() => {
          if (!control.enabled) return;
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        {label} <span aria-hidden>▾</span>
      </button>
      {open ? (
        <div className="limit-menu" role="menu" data-testid={`rate-limit-${kind}-menu`}>
          {control.options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="menuitem"
              data-testid={`rate-limit-${kind}-option`}
              onClick={() => {
                setOpen(false);
                choose(o.id);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
