// SnoozeSheet — the one place a snooze is chosen, for a chat and for a whole
// project (spec/04 § Snooze, spec/14 § Snooze sheet). A modal sheet: when the
// chats come back, which of them keep running meanwhile, and the single
// button that confirms. Opened through `uiStore.openSnoozeSheet` so it outlives
// the menu or folder header that asked for it.
//
// Choosing a preset only selects it; nothing is applied until the primary
// button (or Enter). The wake time is resolved at that moment — the host only
// ever stores an absolute `snoozedUntil`.

import { useEffect, useRef, useState, type JSX } from 'react';
import { Clock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useChatStore } from '../stores/chatStore.js';
import { useSelectionStore } from '../stores/selectionStore.js';
import { useUiStore, type SnoozeSheetTarget } from '../stores/uiStore.js';
import { ModalOverlay } from './ModalOverlay.js';
import { chatsInProject } from '../lib/chatGroups.js';
import { deriveChatTitle } from '../lib/chatTitle.js';
import { stripMarkdown } from '../lib/stripMarkdown.js';
import { SNOOZE_PRESETS, formatElapsed, formatWakeAt } from '../lib/snoozePresets.js';
import { applySnooze } from '../lib/snoozeApply.js';
import type { ChatRow } from '../stores/types.js';

const CUSTOM = 'custom';

/** The wake time for the chosen option, or null while there is none to show. */
function wakeFor(selected: string | null, customValue: string): number | null {
  if (selected === null) return null;
  if (selected === CUSTOM) {
    // `datetime-local` gives a LOCAL wall-clock string; Date parses it in the
    // user's own zone, which is what "snooze until 9am" means to them.
    const at = new Date(customValue).getTime();
    return customValue === '' || Number.isNaN(at) ? null : at;
  }
  return SNOOZE_PRESETS.find((p) => p.id === selected)?.resolve() ?? null;
}

export function SnoozeSheet(): JSX.Element | null {
  const target = useUiStore((s) => s.snoozeSheet);
  return target === null ? null : <SheetBody target={target} />;
}

function SheetBody({ target }: { target: SnoozeSheetTarget }): JSX.Element {
  const close = useUiStore((s) => s.closeSnoozeSheet);
  const pushError = useUiStore((s) => s.pushError);
  const chats = useChatStore((s) => s.chats);
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [customValue, setCustomValue] = useState('');

  // A project and a multi-selection are both "several chats"; only the title differs.
  const isProject = target.kind !== 'chat';
  const targets: ChatRow[] =
    target.kind === 'project'
      ? chatsInProject(Object.values(chats), target.folder)
      : target.kind === 'chats'
        ? target.chatIds.flatMap((id) => (chats[id] ? [chats[id]!] : []))
        : chats[target.chatId]
          ? [chats[target.chatId]!]
          : [];
  const running = targets.filter((c) => c.activity === 'running');
  const notRunning = targets.length - running.length;
  const name =
    target.kind === 'project'
      ? target.name
      : target.kind === 'chats'
        ? `${targets.length} chats`
        : stripMarkdown(deriveChatTitle(targets[0]?.name ?? null));
  const wake = wakeFor(selected, customValue);
  const canConfirm = selected !== null && targets.length > 0;

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  function confirm(): void {
    if (!canConfirm) return;
    let at: number;
    if (selected === CUSTOM) {
      if (wake === null) {
        pushError('snooze: pick a date and time');
        return;
      }
      if (wake <= Date.now()) {
        // NO FALLBACK — a past time is not quietly rounded up to "now".
        pushError('snooze: pick a time in the future');
        return;
      }
      at = wake;
    } else {
      at = wakeFor(selected, '')!;
    }
    close();
    if (target.kind === 'chats') useSelectionStore.getState().clear();
    applySnooze({ targets, until: at, name, isProject, navigate });
  }

  // Esc cancels and Enter confirms, wherever focus is — except on a button of
  // the sheet's own, where Enter does what that button says.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        confirm();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const primaryLabel =
    wake === null
      ? 'Snooze'
      : isProject
        ? `Snooze ${targets.length} until ${formatWakeAt(wake)}`
        : `Snooze until ${formatWakeAt(wake)}`;

  return (
    <ModalOverlay testId="snooze-sheet-overlay">
      <div
        className="modal-backdrop snooze-scrim"
        data-testid="snooze-sheet-scrim"
        onClick={close}
      />
      <div
        className="snooze-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={target.kind === 'project' ? `Snooze ${name}` : 'Snooze'}
        data-testid="snooze-sheet"
        tabIndex={-1}
        ref={rootRef}
      >
        <div className="snooze-sheet-head">
          <h2 className="display" data-testid="snooze-sheet-title">
            {target.kind === 'project' ? `Snooze ${name}` : 'Snooze'}
          </h2>
          <span data-testid="snooze-sheet-subtitle">
            {isProject ? `${targets.length} ${targets.length === 1 ? 'chat' : 'chats'}` : name}
          </span>
        </div>

        <div className="snooze-presets">
          {SNOOZE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`snooze-preset${selected === p.id ? ' on' : ''}`}
              data-testid={`snooze-sheet-preset-${p.id}`}
              aria-pressed={selected === p.id}
              onClick={() => {
                setSelected(p.id);
                rootRef.current?.focus();
              }}
            >
              <span>{p.label}</span>
              <span className="snooze-preset-at">{formatWakeAt(p.resolve())}</span>
            </button>
          ))}
          <button
            type="button"
            className={`snooze-preset${selected === CUSTOM ? ' on' : ''}`}
            data-testid="snooze-sheet-preset-custom"
            aria-pressed={selected === CUSTOM}
            onClick={() => setSelected(CUSTOM)}
          >
            <span>Custom…</span>
          </button>
        </div>
        {selected === CUSTOM ? (
          <input
            type="datetime-local"
            className="snooze-custom-input"
            data-testid="snooze-sheet-custom-input"
            aria-label={isProject ? 'snooze all until' : 'snooze until'}
            value={customValue}
            autoFocus
            onChange={(e) => setCustomValue(e.target.value)}
          />
        ) : null}

        {running.length > 0 ? (
          <div className="snooze-run" data-testid="snooze-sheet-run">
            <div className="snooze-run-head">
              <Clock size={14} aria-hidden />
              Run in background
              <span>{running.length}</span>
            </div>
            {running.map((c) => (
              <div className="snooze-run-item" key={c.chatId} data-testid="snooze-sheet-run-item">
                <span className="badge badge-working" />
                <div>
                  <b>{isProject ? stripMarkdown(deriveChatTitle(c.name)) : 'This chat'}</b>
                  {c.statusSummary ? <span>{stripMarkdown(c.statusSummary)}</span> : null}
                </div>
                {c.runningSince ? (
                  <span className="snooze-run-time">
                    {formatElapsed(Date.now() - c.runningSince)}
                  </span>
                ) : null}
              </div>
            ))}
            {isProject && notRunning > 0 ? (
              <div className="snooze-run-others">+ {notRunning} not running</div>
            ) : null}
          </div>
        ) : null}

        <div className="snooze-rule">Snoozed chats keep running and reappear when scheduled</div>

        <div className="snooze-actions">
          <button
            type="button"
            className="snooze-ghost"
            data-testid="snooze-sheet-cancel"
            onClick={close}
          >
            Cancel
          </button>
          <span className="snooze-actions-gap" />
          <button
            type="button"
            className="snooze-primary"
            data-testid="snooze-sheet-confirm"
            disabled={!canConfirm}
            onClick={confirm}
          >
            <Clock size={15} aria-hidden />
            {primaryLabel}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
