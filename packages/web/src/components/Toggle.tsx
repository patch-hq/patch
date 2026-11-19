// Toggle — the canonical boolean control (spec/14 § Controls: toggles, never
// checkboxes). A real switch: an accessible checkbox is visually hidden behind
// a track+knob. The optional label names the setting; callers may make it
// follow the state ("Enabled"/"Disabled").

import type { JSX } from 'react';

export function Toggle({
  checked,
  onChange,
  label,
  testid,
  disabled,
  title,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  testid?: string;
  disabled?: boolean;
  title?: string;
  /** Names the switch for assistive tech when the row beside it already shows the words. */
  ariaLabel?: string;
}): JSX.Element {
  return (
    <label className="toggle" title={title}>
      <input
        type="checkbox"
        role="switch"
        className="toggle-input"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testid}
      />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-knob" />
      </span>
      {label ? <span className="toggle-label">{label}</span> : null}
    </label>
  );
}
