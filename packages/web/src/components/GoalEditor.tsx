// GoalEditor — the one place a chat's goal is set or changed from a surface
// (spec/04 § Goals, spec/14 § Goals). Besides the goal text it takes the goals
// that follow it (each starts when the one before is met), how often the goal
// is restated to the agent, and how often the evaluator is asked whether the
// work is on track. Used by the goal row's Edit and the header menu's Set goal.

import { useEffect, useRef, useState, type JSX } from 'react';
import { Plus, X } from 'lucide-react';
import type { ReminderEvery } from '@patch/wire';
import type { ChatRow, GoalPlan } from '../stores/types.js';
import { ModalOverlay } from './ModalOverlay.js';

export interface GoalDraft {
  goal: string | null;
  plan: GoalPlan;
}

/** The plan a row carries today, in the shape the editor and REST take. */
export function planOf(row: ChatRow): Required<GoalPlan> {
  return {
    then: row.goalQueue ?? [],
    remindEvery: row.goalReminderEvery ?? null,
    checkInEvery: row.goalCheckInEvery ?? null,
  };
}

function CadenceField({
  label,
  testId,
  value,
  onChange,
}: {
  label: string;
  testId: string;
  value: ReminderEvery | null;
  onChange: (next: ReminderEvery | null) => void;
}): JSX.Element {
  return (
    <div className="goal-cadence">
      <span className="goal-cadence-label">{label}</span>
      <select
        data-testid={`${testId}-unit`}
        aria-label={`${label} cadence`}
        value={value?.unit ?? 'never'}
        onChange={(e) => {
          const unit = e.target.value;
          onChange(
            unit === 'never' ? null : { unit: unit as 'turns' | 'minutes', n: value?.n ?? 5 },
          );
        }}
      >
        <option value="never">Never</option>
        <option value="turns">Every N turns</option>
        <option value="minutes">Every N minutes</option>
      </select>
      {value !== null && (
        <input
          type="number"
          min={1}
          max={10000}
          data-testid={`${testId}-n`}
          aria-label={`${label} every`}
          value={value.n}
          onChange={(e) => {
            const n = Math.min(10000, Math.max(1, Math.floor(Number(e.target.value) || 1)));
            onChange({ unit: value.unit, n });
          }}
        />
      )}
    </div>
  );
}

function sameEvery(a: ReminderEvery | null, b: ReminderEvery | null): boolean {
  return a === b || (a !== null && b !== null && a.unit === b.unit && a.n === b.n);
}

export function GoalEditor({
  goal,
  plan,
  onSave,
  onSaveAndSnooze,
  onClose,
}: {
  goal: string | null;
  plan: Required<GoalPlan>;
  /** `goal: null` clears. Called only when something changed. */
  onSave: (draft: GoalDraft) => void;
  /** When given and no goal is set yet, offers "Set goal and snooze". */
  onSaveAndSnooze?: (draft: GoalDraft) => void;
  onClose: () => void;
}): JSX.Element {
  const [text, setText] = useState(goal ?? '');
  const [then, setThen] = useState<string[]>(plan.then);
  const [remind, setRemind] = useState<ReminderEvery | null>(plan.remindEvery);
  const [checkIn, setCheckIn] = useState<ReminderEvery | null>(plan.checkInEvery);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cleaned = then.map((g) => g.trim()).filter((g) => g !== '');
  const next = text.trim();
  const changed =
    next !== (goal ?? '') ||
    cleaned.length !== plan.then.length ||
    cleaned.some((g, i) => g !== plan.then[i]) ||
    !sameEvery(remind, plan.remindEvery) ||
    !sameEvery(checkIn, plan.checkInEvery);

  function draft(): GoalDraft {
    return {
      goal: next === '' ? null : next,
      plan:
        next === '' || (cleaned.length === 0 && remind === null && checkIn === null)
          ? {}
          : { then: cleaned, remindEvery: remind, checkInEvery: checkIn },
    };
  }

  function save(): void {
    if (next === '' && goal === null) return;
    if (changed) onSave(draft());
    onClose();
  }

  function saveAndSnooze(): void {
    if (next === '' || !onSaveAndSnooze) return;
    onSaveAndSnooze(draft());
    onClose();
  }

  return (
    <ModalOverlay testId="goal-edit-overlay">
      <div className="modal-backdrop" onClick={onClose} />
      <div
        className="modal-card goal-edit-modal"
        data-testid="goal-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-label={goal === null ? 'Set goal' : 'Edit goal'}
      >
        <textarea
          ref={ref}
          className="goal-edit-input"
          data-testid="goal-edit-input"
          aria-label="Goal"
          value={text}
          rows={4}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
        />
        {then.map((g, i) => (
          <div className="goal-then-row" key={i}>
            <span className="goal-then-index">Then {i + 1}</span>
            <textarea
              rows={2}
              className="goal-then-input"
              data-testid={`goal-then-${i}`}
              aria-label={`Then goal ${i + 1}`}
              value={g}
              onChange={(e) => setThen(then.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button
              type="button"
              data-testid={`goal-then-remove-${i}`}
              aria-label={`Remove then goal ${i + 1}`}
              onClick={() => setThen(then.filter((_, j) => j !== i))}
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="status-link goal-then-add"
          data-testid="goal-then-add"
          onClick={() => setThen([...then, ''])}
        >
          <Plus size={14} aria-hidden /> Then goal
        </button>
        <CadenceField label="Remind" testId="goal-remind" value={remind} onChange={setRemind} />
        <CadenceField
          label="Check in"
          testId="goal-checkin"
          value={checkIn}
          onChange={setCheckIn}
        />
        <div className="modal-actions">
          <button
            type="button"
            className="modal-btn"
            data-testid="goal-edit-cancel"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="modal-btn primary-btn"
            data-testid="goal-edit-save"
            disabled={next === '' && goal === null}
            onClick={save}
          >
            {goal === null ? 'Set goal' : 'Save'}
          </button>
          {goal === null && onSaveAndSnooze ? (
            <button
              type="button"
              className="modal-btn primary-btn"
              data-testid="goal-edit-save-snooze"
              disabled={next === ''}
              onClick={saveAndSnooze}
            >
              Set goal and snooze
            </button>
          ) : null}
        </div>
      </div>
    </ModalOverlay>
  );
}
