// PopupSelect — a select drawn as a pill whose list stays inside the window.
//
// Why not a native <select>: its list is drawn by the OS, below the control,
// and in the desktop app it ran off the bottom of the window when the control
// sits in the composer row (Todoist 6hr2VWg7J5v5wwhF). The list here is
// portalled to the body and placed by `usePopupPlacement`, so it opens upward
// when there is more room above and scrolls inside the room it has.

import { useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePopupPlacement } from '../lib/popupPlacement.js';
import { useDismissOnClickOff } from '../lib/dismissOnClickOff.js';

export interface PopupSelectOption {
  value: string;
  label: string;
  /** Shown in the trigger when selected, but not offered in the list. */
  hidden?: boolean;
  disabled?: boolean;
  /** A line under the label saying what the choice does. */
  description?: string;
  /** Drawn in the danger colour (a choice that removes a safeguard). */
  danger?: boolean;
}

export function PopupSelect({
  value,
  options,
  onChange,
  testId,
  ariaLabel,
  title,
  disabled = false,
  pending = false,
  icon,
  triggerLabel,
  danger = false,
}: {
  value: string;
  options: PopupSelectOption[];
  onChange: (value: string) => void;
  testId: string;
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  pending?: boolean;
  /** Leads the trigger; with it the trigger can shrink to the icon alone. */
  icon?: ReactNode;
  /**
   * The trigger's word, when it should be shorter than the chosen option's
   * label ("Bypass" for "Bypass — no checks"). Empty shows the icon alone.
   */
  triggerLabel?: string;
  /** Draws the trigger in the danger colour. */
  danger?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const placement = usePopupPlacement(wrapRef, open);
  useDismissOnClickOff(open, [wrapRef, popupRef], () => setOpen(false));
  const [rect, setRect] = useState<{ left: number; top: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    function measure(): void {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ left: r.left, top: r.top, bottom: r.bottom });
    }
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const popup =
    open && rect !== null ? (
      <div
        ref={popupRef}
        className={`model-popup place-${placement.direction} is-portalled popup-select-list`}
        role="listbox"
        data-testid={`${testId}-list`}
        data-direction={placement.direction}
        style={
          placement.direction === 'down'
            ? {
                maxHeight: placement.maxHeight,
                position: 'fixed',
                left: rect.left,
                top: rect.bottom + 4,
              }
            : {
                maxHeight: placement.maxHeight,
                position: 'fixed',
                left: rect.left,
                bottom: window.innerHeight - rect.top + 4,
              }
        }
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        {options
          .filter((o) => !o.hidden)
          .map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              className={`model-option${o.value === value ? ' selected' : ''}${o.danger ? ' danger' : ''}`}
              aria-selected={o.value === value}
              data-value={o.value}
              disabled={o.disabled}
              onClick={() => {
                setOpen(false);
                if (o.value !== value) onChange(o.value);
              }}
            >
              <span className="model-option-name">
                {o.label}
                {o.description !== undefined ? (
                  <span className="model-option-desc">{o.description}</span>
                ) : null}
              </span>
              {o.value === value ? (
                <span className="model-option-check" aria-hidden>
                  ✓
                </span>
              ) : null}
            </button>
          ))}
      </div>
    ) : null;

  const word = triggerLabel ?? selected?.label ?? '';
  return (
    <div className="permission-mode-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`permission-mode${pending ? ' is-pending' : ''}${icon !== undefined ? ' has-icon' : ''}${danger ? ' danger' : ''}`}
        data-testid={testId}
        data-value={value}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        {...(title !== undefined ? { title } : {})}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {icon !== undefined ? (
          <>
            {icon}
            {word !== '' ? (
              <span className="setting-word" data-collapsible="">
                {word}
              </span>
            ) : null}
          </>
        ) : (
          word
        )}
      </button>
      <span className="permission-mode-caret" aria-hidden>
        ▾
      </span>
      {popup !== null ? createPortal(popup, document.body) : null}
    </div>
  );
}
