// A settings number field. It keeps what is being typed in a draft of its own
// and commits only a value that is valid: bound straight to the stored value it
// snapped back on every keystroke that was not already a number, so a field
// could never be cleared to retype it.

import { useState, type JSX } from 'react';

export function PositiveNumberInput({
  value,
  onCommit,
  ariaLabel,
  testid,
  disabled,
  integer = false,
}: {
  value: number;
  onCommit: (next: number) => void;
  ariaLabel: string;
  testid: string;
  disabled?: boolean;
  /** Refuse a fractional value (the field is a count). */
  integer?: boolean;
}): JSX.Element {
  // Null while the stored value is what is shown.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      min={1}
      aria-label={ariaLabel}
      value={draft ?? String(value)}
      disabled={disabled}
      data-testid={testid}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        const next = Number(raw);
        if (raw.trim() === '' || !Number.isFinite(next) || next <= 0) return;
        if (integer && !Number.isInteger(next)) return;
        onCommit(next);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}
