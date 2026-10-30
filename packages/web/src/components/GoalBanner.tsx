// GoalBanner — the Goal row of the status list under the chat header (spec/04
// § Goals, spec/14 § Main chat panel — Status list). The goal is set from the
// composer via `/goal <text>` (which also starts a turn with the condition as
// the directive) and cleared with a bare `/goal`. The row is one folded line —
// state pill, goal text, running time and checks — and its pill opens the
// evaluator's detail (tokens, latest reason, Edit goal). Clicking the goal text
// edits it in a modal (re-arms the evaluator on the new text as a fresh goal,
// same as typing a new `/goal`). Editing and the clear (×) control are both
// optimistic, reverting + surfacing a toast on failure (NO FALLBACK).

import { useEffect, useRef, useState, type JSX } from 'react';
import { CircleCheck, CircleX, Pause, Target, X } from 'lucide-react';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import type { ChatRow } from '../stores/types.js';
import { formatDateTime } from '../lib/formatDateTime.js';
import { ModalOverlay } from './ModalOverlay.js';
import { StatusPill, StatusRow } from './StatusRow.js';

/**
 * Humanise time elapsed since a goal started: `9m`, `1h 4m`, `3h`. Coarsest
 * two units, no seconds — a running total is read at a glance, not ticked
 * precisely like a countdown to a specific instant (`WakeBar.formatWakeCountdown`).
 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Humanise a token count: `842`, `8.2k`, `1.4M`. */
export function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`;
  // 999_999 rounds to "1000.0" at one decimal: that is a million, not "1000k".
  if (Number((n / 1000).toFixed(1)) < 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function GoalEditModal({
  value,
  onSave,
  onClose,
}: {
  value: string;
  onSave: (next: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  function save(): void {
    const next = draft.trim();
    if (next === '') return;
    if (next !== value) onSave(next);
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
        aria-label="Edit goal"
      >
        <textarea
          ref={ref}
          className="goal-edit-input"
          data-testid="goal-edit-input"
          value={draft}
          rows={5}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
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
            disabled={draft.trim() === ''}
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

export function GoalBanner({ row }: { row: ChatRow }): JSX.Element | null {
  const setGoal = useChatStore((s) => s.setGoal);
  const pushError = useUiStore((s) => s.pushError);
  const [now, setNow] = useState(() => Date.now());
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const goal = row.goal;
  const progress = row.goalProgress;

  // Tick the running-time readout. Only while a goal is active — no timer for
  // the (overwhelmingly common) chat with none.
  useEffect(() => {
    if (goal === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [goal]);

  if (goal === null || goal.trim() === '') return null;

  async function writeGoal(next: string | null): Promise<void> {
    const prev = goal;
    setGoal(row.chatId, next);
    try {
      await api.setGoal(row.chatId, next);
    } catch (err) {
      setGoal(row.chatId, prev);
      pushError(
        `${next === null ? 'clearing' : 'updating'} goal failed: ${(err as Error).message}`,
      );
    }
  }

  const paused = progress?.pausedByStop === true;
  const meta = progress
    ? `${formatElapsed(now - progress.startedAt)} · ${progress.turnsEvaluated} check${progress.turnsEvaluated === 1 ? '' : 's'}`
    : null;
  const detail: string[] = [];
  if (progress && progress.tokensSpent > 0)
    detail.push(`${formatTokenCount(progress.tokensSpent)} tokens`);
  if (progress?.lastVerdict === 'not_met' && progress.lastReason !== null)
    detail.push(`Not met: ${progress.lastReason}`);

  const sub =
    paused || expanded ? (
      <>
        {paused && (
          <div data-testid="goal-banner-paused-note">
            You stopped the chat. Send a message to resume.
          </div>
        )}
        {expanded && (
          <div data-testid="goal-banner-detail">
            {detail.length > 0 && (
              <span data-testid="goal-banner-reason">{detail.join(' · ')} · </span>
            )}
            <button
              type="button"
              className="status-link status-link-underline"
              data-testid="goal-edit-link"
              onClick={() => setEditing(true)}
            >
              Edit goal
            </button>
          </div>
        )}
      </>
    ) : undefined;

  return (
    <>
      <StatusRow
        testId="goal-banner"
        data-paused={paused ? 'true' : 'false'}
        role="status"
        icon={
          paused ? (
            <Pause size={16} aria-hidden />
          ) : (
            <Target size={16} className="goal-icon-working" aria-hidden />
          )
        }
        label="Goal"
        wrap={expanded}
        meta={meta}
        sub={sub}
        action={
          <button
            type="button"
            data-testid="goal-clear-btn"
            aria-label="Clear goal"
            title="Clear goal"
            onClick={() => void writeGoal(null)}
          >
            <X size={16} aria-hidden />
          </button>
        }
      >
        <StatusPill
          testId="goal-pill"
          open={expanded}
          onToggle={() => setExpanded((v) => !v)}
          label={expanded ? 'Hide goal details' : 'Show goal details'}
        >
          {paused ? 'Paused' : 'Working'}
        </StatusPill>
        <button
          type="button"
          className="status-link status-grow"
          data-testid="goal-banner-text"
          aria-label="Edit goal"
          title={goal}
          onClick={() => setEditing(true)}
        >
          {goal}
        </button>
      </StatusRow>
      {editing && (
        <GoalEditModal
          value={goal}
          onSave={(next) => void writeGoal(next)}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

const DISMISSED_KEY = 'patch.finishedGoalDismissed';

function readDismissed(): Record<string, number> {
  const raw = localStorage.getItem(DISMISSED_KEY);
  return raw === null ? {} : (JSON.parse(raw) as Record<string, number>);
}

/**
 * spec/04 § Goals — a finished goal stays viewable as a Goal row in the status
 * list. Folded: outcome pill, goal text, finish time. Opened: duration, checks,
 * tokens and the evaluator's reason, wrapped. Dismissible per finished goal
 * (remembered by its end time, so the next goal to finish shows again).
 */
export function FinishedGoalBanner({ row }: { row: ChatRow }): JSX.Element | null {
  const last = row.lastGoal;
  const [dismissed, setDismissed] = useState<Record<string, number>>(readDismissed);
  const [expanded, setExpanded] = useState(false);
  if (row.goal !== null || last === null || dismissed[row.chatId] === last.endedAt) return null;
  const met = last.outcome === 'met';
  function dismiss(): void {
    const next = { ...dismissed, [row.chatId]: last!.endedAt };
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
    setDismissed(next);
  }
  return (
    <StatusRow
      testId="finished-goal-banner"
      role="status"
      icon={
        met ? (
          <CircleCheck size={16} className="goal-icon-met" aria-hidden />
        ) : (
          <CircleX size={16} aria-hidden />
        )
      }
      label="Goal"
      wrap={expanded}
      meta={<span data-testid="finished-goal-time">{formatDateTime(last.endedAt)}</span>}
      sub={
        expanded ? (
          <div data-testid="finished-goal-detail">
            {formatElapsed(last.endedAt - last.startedAt)} · {last.turns} check
            {last.turns === 1 ? '' : 's'}
            {last.tokens > 0 ? ` · ${formatTokenCount(last.tokens)} tokens` : ''}. {last.reason}
          </div>
        ) : undefined
      }
      action={
        <button
          type="button"
          data-testid="finished-goal-dismiss"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={dismiss}
        >
          <X size={16} aria-hidden />
        </button>
      }
    >
      <StatusPill
        testId="finished-goal-pill"
        open={expanded}
        onToggle={() => setExpanded((v) => !v)}
        label={expanded ? 'Hide goal details' : 'Show goal details'}
      >
        {met ? 'Met' : 'Impossible'}
      </StatusPill>
      <span className="status-grow" data-testid="finished-goal-summary" title={last.condition}>
        {last.condition}
      </span>
    </StatusRow>
  );
}
