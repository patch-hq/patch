// Move a chat to another host (spec/04 § Moving a chat to another host,
// spec/14 § Chat header). Pick the machine, then the folder the chat will run
// in there — offered from that machine's own folders, the one with the same
// name as the chat's current folder chosen first, else the first it offers —
// or type a path. The chat
// stays where it is until the server says it has arrived; a refusal keeps the
// dialog open with the reason. When the chat's own machine is offline the move
// is a takeover from the server's copy: the dialog says what stays behind and
// the same-named folder is only suggested, never filled in.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { defaultMoveFolder } from '@patch/wire';
import { api, ApiError } from '../api/rest.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import type { ChatRow } from '../stores/types.js';
import { ModalOverlay } from './ModalOverlay.js';

function hostName(h: { hostId: string; host: { hostName: string } | null }): string {
  return h.host?.hostName ?? h.hostId;
}

export function MoveChatModal({
  row,
  onClose,
}: {
  row: ChatRow;
  onClose: () => void;
}): JSX.Element {
  const hosts = usePresenceStore((s) => s.hosts);
  const targets = useMemo(
    () =>
      Object.values(hosts)
        .filter((h) => h.hostId !== row.hostId)
        .sort((a, b) => hostName(a).localeCompare(hostName(b))),
    [hosts, row.hostId],
  );
  const [hostId, setHostId] = useState<string | null>(
    () => targets.find((h) => h.online)?.hostId ?? null,
  );
  const folders = useMemo(() => {
    const f = hostId ? hosts[hostId]?.folders : null;
    return [...new Set([...(f?.roots ?? []), ...(f?.recent ?? [])])];
  }, [hosts, hostId]);
  const current = hosts[row.hostId];
  const offline = current !== undefined && !current.online;
  // The user can also leave an online machine behind: a move it would refuse
  // (mid-turn, a timer armed) goes through from the server's copy.
  const [fromCopy, setFromCopy] = useState(false);
  const takeover = offline || fromCopy;
  const [folder, setFolder] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  // `folders` is rebuilt on every presence update, so effects key on its content
  // and read it through a ref: an unrelated update must not rewrite the field.
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  const foldersKey = folders.join('\n');
  const typed = useRef(false);

  // A new machine offers its own folder — never the path typed for another one.
  useEffect(() => {
    typed.current = false;
    setFolder(takeover ? '' : (defaultMoveFolder(row.folder, foldersRef.current) ?? ''));
    setError(null);
  }, [hostId, row.folder, takeover]);

  // A folder list that arrives or changes refines the offer, until someone types.
  useEffect(() => {
    if (!typed.current && !takeover) {
      setFolder(defaultMoveFolder(row.folder, foldersRef.current) ?? '');
    }
  }, [foldersKey, row.folder, takeover]);
  const suggestion = takeover ? defaultMoveFolder(row.folder, folders) : undefined;

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && !moving) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moving, onClose]);

  async function move(): Promise<void> {
    if (!hostId || folder.trim().length === 0) return;
    setMoving(true);
    setError(null);
    try {
      if (fromCopy && !offline) {
        await api.moveChat(row.chatId, hostId, folder.trim(), { fromServerCopy: true });
      } else {
        await api.moveChat(row.chatId, hostId, folder.trim());
      }
      onClose();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { message?: unknown } | null) : null;
      setError(typeof body?.message === 'string' ? body.message : (e as Error).message);
    } finally {
      setMoving(false);
    }
  }

  return (
    <ModalOverlay testId="move-chat-modal-overlay">
      <div className="modal-backdrop" onClick={() => (moving ? undefined : onClose())} />
      <div
        className="modal-card move-chat-modal"
        data-testid="move-chat-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Move chat"
      >
        <h2 className="modal-title">Move chat</h2>
        <p className="modal-message move-chat-from" data-testid="move-chat-from">
          {current ? hostName(current) : row.hostId} · {row.folder}
        </p>
        <div className="move-chat-hosts" role="radiogroup" aria-label="Machine">
          {targets.map((h) => (
            <button
              key={h.hostId}
              type="button"
              role="radio"
              aria-checked={hostId === h.hostId}
              className={`move-chat-host${hostId === h.hostId ? ' is-selected' : ''}`}
              data-testid={`move-chat-host-${h.hostId}`}
              disabled={!h.online || moving}
              onClick={() => setHostId(h.hostId)}
            >
              {hostName(h)}
              {h.online ? null : <span className="move-chat-offline"> · offline</span>}
            </button>
          ))}
        </div>
        {takeover ? (
          <p className="modal-message" data-testid="move-chat-takeover-note">
            {offline ? `${hostName(current)} is offline. ` : ''}The chat continues from the server's
            copy. Uncommitted project files and watched processes stay on that machine. Timers and
            attachments move with the chat.
          </p>
        ) : null}
        {offline ? null : (
          <button
            type="button"
            className="modal-btn"
            data-testid="move-chat-from-copy"
            aria-pressed={fromCopy}
            disabled={moving}
            onClick={() => setFromCopy((v) => !v)}
          >
            {fromCopy ? 'Move as it is instead' : "Continue from the server's copy instead"}
          </button>
        )}
        {targets.length === 0 ? (
          <p className="modal-message" data-testid="move-chat-no-hosts">
            No other machine
          </p>
        ) : null}
        <input
          className="prompt-modal-input"
          data-testid="move-chat-folder"
          type="text"
          list="move-chat-folders"
          value={folder}
          placeholder="Folder on that machine"
          aria-label="Folder"
          disabled={!hostId || moving}
          onChange={(e) => {
            typed.current = true;
            setFolder(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            void move();
          }}
        />
        {suggestion ? (
          <button
            type="button"
            className="modal-btn"
            data-testid="move-chat-suggest"
            disabled={moving}
            onClick={() => {
              typed.current = true;
              setFolder(suggestion);
            }}
          >
            Suggested: {suggestion}
          </button>
        ) : null}
        <datalist id="move-chat-folders">
          {folders.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        {error ? (
          <p className="move-chat-error" data-testid="move-chat-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button
            type="button"
            className="modal-btn"
            data-testid="move-chat-cancel"
            disabled={moving}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="modal-btn primary-btn"
            data-testid="move-chat-confirm"
            disabled={!hostId || folder.trim().length === 0 || moving}
            onClick={() => void move()}
          >
            {moving ? 'Moving…' : takeover ? 'Continue' : 'Move'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
