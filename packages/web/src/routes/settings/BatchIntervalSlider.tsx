// Settings → Manager → Finished chats → Every: how often a batch of finished
// chats is sent to the Manager (spec/06 § Finished chats).

import { useEffect, useRef, useState, type JSX } from 'react';
import { MANAGER_WAKE_INTERVAL_CHOICES } from '@patch/wire';

export function intervalLabel(minutes: number): string {
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} min`;
  const h = minutes / 60;
  return h === 24 ? 'a day' : `${h} h`;
}

/** The slider's steps, plus the stored value when it is not one of them, so it is shown as it is. */
function stepsFor(value: number): number[] {
  const steps: number[] = [...MANAGER_WAKE_INTERVAL_CHOICES];
  if (!steps.includes(value)) steps.push(value);
  return steps.sort((a, b) => a - b);
}

const COMMIT_AFTER_MS = 300;

export function BatchIntervalSlider({
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
        aria-label="Batch every"
        aria-valuetext={intervalLabel(shown)}
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
        {intervalLabel(shown)}
      </span>
    </span>
  );
}
