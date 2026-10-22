// WakeEditModal — roomy editor for a chat's pending self-wake (spec/02 § Self-wake).
// Saving re-arms through `api.setLoop`, which replaces the one pending wake, so
// the same path serves wakes armed by the agent or by the user.

import { useState, type JSX } from 'react';
import { api } from '../api/rest.js';
import { useUiStore } from '../stores/uiStore.js';
import type { ChatRow } from '../stores/types.js';
import { failed } from '../lib/errorCopy.js';
import { ModalOverlay } from './ModalOverlay.js';
import { formatEvery } from './WakeBar.js';

type Wake = NonNullable<ChatRow['pendingWake']>;

function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export function WakeEditModal({
  chatId,
  wake,
  onClose,
}: {
  chatId: string;
  wake: Wake;
  onClose: () => void;
}): JSX.Element {
  const pushError = useUiStore((s) => s.pushError);
  const isLoop = wake.every !== undefined;
  const [message, setMessage] = useState(wake.message);
  const [every, setEvery] = useState(isLoop ? formatEvery(wake.every!).replace(/ /g, '') : '');
  const initialAt = toLocalInput(wake.fireAt);
  const [at, setAt] = useState(initialAt);
  const [saving, setSaving] = useState(false);

  const valid = message.trim() !== '' && (isLoop ? every.trim() !== '' : at !== '');

  async function save(): Promise<void> {
    setSaving(true);
    try {
      if (isLoop) {
        await api.setLoop(chatId, {
          message,
          every: every.trim(),
          ...(wake.notAfter !== undefined
            ? { notAfter: new Date(wake.notAfter).toISOString() }
            : {}),
        });
      } else {
        // An untouched time keeps the exact original fire time (the input only
        // has minute resolution).
        const iso =
          at === initialAt ? new Date(wake.fireAt).toISOString() : new Date(at).toISOString();
        await api.setLoop(chatId, { message, at: iso });
      }
      onClose();
    } catch (err) {
      pushError(failed('saving wake'), undefined, (err as Error).message);
      setSaving(false);
    }
  }

  return (
    <ModalOverlay testId="wake-edit-overlay">
      <div className="modal-backdrop" onClick={onClose} />
      <div
        className="modal-card wake-edit-modal"
        data-testid="wake-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edit wake"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h2 className="modal-title">Edit wake</h2>
        <label className="wake-edit-field">
          <span>Message</span>
          <textarea
            data-testid="wake-edit-message"
            className="wake-edit-textarea"
            value={message}
            autoFocus
            rows={10}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        {isLoop ? (
          <label className="wake-edit-field">
            <span>Every</span>
            <input
              data-testid="wake-edit-every"
              className="prompt-modal-input"
              type="text"
              value={every}
              placeholder="10m, 1h30m"
              onChange={(e) => setEvery(e.target.value)}
            />
          </label>
        ) : (
          <label className="wake-edit-field">
            <span>Wakes at</span>
            <input
              data-testid="wake-edit-at"
              className="prompt-modal-input"
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </label>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="modal-btn"
            data-testid="wake-edit-cancel"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="modal-btn primary-btn"
            data-testid="wake-edit-save"
            disabled={!valid || saving}
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
