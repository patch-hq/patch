// Settings → Manager → "Questions for me": how soon a question the Manager
// could not answer reaches Tom (spec/06 § The sweep, job 3). One end is
// Instant (a notification as the chat goes idle), the other batches them into
// one digest every N minutes or hours. The list is the same either way.

import { useEffect, useRef, useState, type JSX } from 'react';

/** Minutes between digests; 0 is Instant. */
export const DELIVERY_STEPS = [0, 5, 15, 30, 60, 120, 240, 480, 1440] as const;

export function deliveryLabel(minutes: number): string {
  if (minutes === 0) return 'Instant';
  if (minutes < 60) return `Digest every ${minutes} min`;
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 24 ? 'Digest every day' : `Digest every ${h} h`;
  }
  return `Digest every ${minutes} min`;
}

/** The slider's steps, plus the stored value when it is not one of them, so it is shown as it is. */
function stepsFor(value: number): number[] {
  const steps: number[] = [...DELIVERY_STEPS];
  if (!steps.includes(value)) steps.push(value);
  return steps.sort((a, b) => a - b);
}

const COMMIT_AFTER_MS = 300;

export function DeliverySlider({
  value,
  onCommit,
  disabled,
  testid,
}: {
  value: number;
  onCommit: (next: number) => void;
  disabled?: boolean;
  testid: string;
}): JSX.Element {
  const steps = stepsFor(value);
  // Null while the stored value is what is shown.
  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const shown = draft ?? value;
  return (
    <span className="set-slider">
      <input
        type="range"
        min={0}
        max={steps.length - 1}
        step={1}
        value={steps.indexOf(shown)}
        disabled={disabled}
        aria-label="How soon questions reach me"
        aria-valuetext={deliveryLabel(shown)}
        data-testid={testid}
        onChange={(e) => {
          const next = steps[Number(e.target.value)]!;
          setDraft(next);
          // One write when the slider settles, not one per step it passes.
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            timer.current = null;
            if (next !== value) onCommit(next);
            setDraft(null);
          }, COMMIT_AFTER_MS);
        }}
      />
      <span className="set-unit" data-testid={`${testid}-label`}>
        {deliveryLabel(shown)}
      </span>
    </span>
  );
}
