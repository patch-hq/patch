// EffortControl — Claude's thinking-effort override, and the control that
// changes it (spec/04 § Effort, spec/14 § Composer — Effort control). Sits in
// the composer's action row beside the model control: both are standing
// settings for the NEXT turn. Claude backend only — rendered as `null` for a
// chat on another backend, same as `ChatModelControl` renders `null` for a
// chat with no model to show at all.
//
// Unlike the model picker there is no live catalogue to load: the five effort
// levels are fixed (spec/02 § Agent backends), so this is a much smaller
// cousin of `ModelPicker` — a pill + pop-up over a constant list, including a
// `Default` row that clears the override.

import { useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { Gauge } from 'lucide-react';
import type { EffortLevel } from '@patch/wire';
import { harnessForModel } from '@patch/wire';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePopupPlacement } from '../lib/popupPlacement.js';
import { useDismissOnClickOff } from '../lib/dismissOnClickOff.js';
import { getActiveWs } from '../api/ws.js';

const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** Same reasoning as `ChatModelControl`'s own timeout. */
const EFFORT_CONFIRM_TIMEOUT_MS = 8000;

export function EffortControl({ chatId }: { chatId: string }): JSX.Element | null {
  const row = useChatStore((s) => s.chats[chatId]);
  if (!row?.model || harnessForModel(row.model) !== 'claude') return null;
  return <Control chatId={chatId} />;
}

function Control({ chatId }: { chatId: string }): JSX.Element {
  const row = useChatStore((s) => s.chats[chatId])!;
  const pushError = useUiStore((s) => s.pushError);
  const hostLabel = usePresenceStore((s) =>
    (s.hosts[row.hostId]?.host?.hostName ?? row.hostId).trim(),
  );
  const [open, setOpen] = useState(false);
  // spec/04 § Effort — held as PENDING until the host confirms it on
  // `chat.state`, the same reasoning as the model control's own pending state.
  // `false` means "no pending change"; the chosen value is read off
  // `pendingEffort.value` so a pending `null` (clearing to Default) is
  // distinguishable from no pending change at all.
  const [pending, setPending] = useState<{ value: EffortLevel | null } | false>(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const placement = usePopupPlacement(anchorRef, open);
  useDismissOnClickOff(open, [anchorRef, popupRef], () => setOpen(false));

  useEffect(() => {
    if (pending !== false && row.effort === pending.value) setPending(false);
  }, [pending, row.effort]);
  useEffect(() => {
    if (pending === false) return;
    const t = setTimeout(() => {
      setPending(false);
      pushError(
        `${hostLabel} did not switch the effort level — this chat is still on the value it had`,
      );
    }, EFFORT_CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [pending, hostLabel, pushError]);

  const current = pending !== false ? pending.value : row.effort;

  function choose(effort: EffortLevel | null): void {
    setOpen(false);
    // Compare against the EFFECTIVE value (including a still-unconfirmed
    // pending one), not `row.effort` alone — a second choice made before the
    // host has acknowledged the first must still send, even though the store
    // has not moved off the original value yet.
    if (effort === current) return;
    setPending({ value: effort });
    getActiveWs()?.send({ type: 'chat.effort_request', chatId: row.chatId, effort });
  }

  // Unset reads as the icon alone: "Default" told the user nothing (spec/14 §
  // Composer — Effort control). The tooltip and the list say what it means.
  const label = current === null ? '' : EFFORT_LABELS[current];

  // Portalled to the body, same reasoning as `ModelPicker`'s `crumb` variant:
  // the composer action row sits low in the chat window and is painted over
  // by surrounding chrome in place, so the pop-up is positioned from the
  // anchor's measured rect instead of relying on in-flow absolute placement.
  const [anchorRect, setAnchorRect] = useState<{
    left: number;
    top: number;
    bottom: number;
  } | null>(null);
  useEffect(() => {
    if (!open) return;
    function measure(): void {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setAnchorRect({ left: r.left, top: r.top, bottom: r.bottom });
    }
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);

  return (
    <div className="model-picker as-crumb" ref={anchorRef}>
      <button
        type="button"
        className={`model-pill as-crumb has-icon ${pending !== false ? 'is-pending' : ''}`}
        data-testid="chat-effort"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="thinking effort"
        title={
          current === null
            ? 'Thinking effort: the model decides'
            : `Thinking effort: ${EFFORT_LABELS[current]}`
        }
        onClick={() => setOpen((v) => !v)}
      >
        <Gauge size={16} aria-hidden />
        {label !== '' ? (
          <span className="model-pill-label setting-word" data-collapsible="">
            {label}
          </span>
        ) : null}
        <span className="model-pill-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open &&
        anchorRect !== null &&
        createPortal(
          <div
            ref={popupRef}
            className={`model-popup place-${placement.direction} is-portalled`}
            style={
              placement.direction === 'down'
                ? {
                    maxHeight: placement.maxHeight,
                    position: 'fixed',
                    left: anchorRect.left,
                    top: anchorRect.bottom + 4,
                  }
                : anchorRect.top - 4 - placement.maxHeight >= 0
                  ? {
                      maxHeight: placement.maxHeight,
                      position: 'fixed',
                      left: anchorRect.left,
                      bottom: window.innerHeight - anchorRect.top + 4,
                    }
                  : {
                      maxHeight: placement.maxHeight,
                      position: 'fixed',
                      left: anchorRect.left,
                      top: 8,
                      bottom: 'auto',
                    }
            }
            data-testid="effort-popup"
            role="listbox"
          >
            <div className="model-popup-note" data-testid="effort-popup-note">
              {row.activity === 'running'
                ? 'Applies to your next message — this turn keeps its effort'
                : 'Applies to your next message'}
            </div>
            <ul className="model-popup-list">
              <li>
                <button
                  type="button"
                  className={`model-option ${current === null ? 'selected' : ''}`}
                  data-testid="effort-option-default"
                  role="option"
                  aria-selected={current === null}
                  onClick={() => choose(null)}
                >
                  <span className="model-option-name">
                    Let the model decide
                    <span className="model-option-desc">The model’s own default</span>
                  </span>
                  {current === null ? (
                    <span className="model-option-check" aria-hidden>
                      ✓
                    </span>
                  ) : null}
                </button>
              </li>
              {EFFORT_LEVELS.map((level) => (
                <li key={level}>
                  <button
                    type="button"
                    className={`model-option ${level === current ? 'selected' : ''}`}
                    data-testid={`effort-option-${level}`}
                    role="option"
                    aria-selected={level === current}
                    onClick={() => choose(level)}
                  >
                    <span className="model-option-name">{EFFORT_LABELS[level]}</span>
                    {level === current ? (
                      <span className="model-option-check" aria-hidden>
                        ✓
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}
