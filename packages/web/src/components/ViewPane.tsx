// ViewPane — a lasting view open in a pane (spec/14 § Views). The template
// ("review-list") draws the agent's data document: each item with Yes / No and a
// note. The agent changes the document while the pane is open and it updates in
// place; the user's marks are saved as they are made and go to the agent when
// Send is pressed.

import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Trash2 } from 'lucide-react';
import { api, type ViewJson, type ViewMark } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { failed } from '../lib/errorCopy.js';

const POLL_MS = 2000;

export function ViewPane({ viewId }: { viewId: string }): JSX.Element {
  const qc = useQueryClient();
  const pushError = useUiStore((s) => s.pushError);
  const { data: view, error } = useQuery<ViewJson>({
    queryKey: ['view', viewId],
    // Ask only for what changed since the copy held; an unchanged answer keeps it.
    queryFn: async () => {
      const held = qc.getQueryData<ViewJson>(['view', viewId]);
      if (!held) return api.getView(viewId);
      const next = await api.pollView(viewId, held.rev);
      if ('unchanged' in next) return { ...held, unsent: next.unsent };
      return next;
    },
    refetchInterval: POLL_MS,
  });
  const chatName = useChatStore((s) => (view ? s.chats[view.chatId]?.name : undefined));

  const put = (next: ViewJson): void => void qc.setQueryData(['view', viewId], next);
  const mark = useMutation({
    mutationFn: (b: { itemId: string; verdict?: 'yes' | 'no' | null; note?: string }) =>
      api.markView(viewId, b),
    onSuccess: (v) => put(v),
    onError: (e) => pushError(failed('save that mark'), undefined, (e as Error).message),
  });
  const send = useMutation({
    mutationFn: () => api.sendView(viewId),
    onSuccess: (r) => put(r.view),
    onError: (e) => pushError(failed('send the marks'), undefined, (e as Error).message),
  });
  const del = useMutation({
    mutationFn: () => api.deleteView(viewId),
    onSuccess: () => {
      const l = useLayoutStore.getState();
      const tab = l.findTab({ kind: 'page', page: 'view', viewId });
      if (tab) l.closeTab(tab.pane.id, tab.tab.id);
    },
    onError: (e) => pushError(failed('delete the view'), undefined, (e as Error).message),
  });

  if (error) {
    return (
      <div className="view-pane" data-testid="view-pane">
        <p className="view-error" data-testid="view-error">
          View unavailable: {(error as Error).message}
        </p>
      </div>
    );
  }
  if (!view) return <div className="view-pane" data-testid="view-pane" />;

  return (
    <div className="view-pane" data-testid="view-pane">
      <header className="view-head">
        <div>
          <h2 className="view-title" data-testid="view-title">
            {view.title}
          </h2>
          {chatName ? (
            <button
              type="button"
              className="view-chat"
              onClick={() => useLayoutStore.getState().showChat(view.chatId)}
            >
              <MessageSquare size={12} aria-hidden /> {chatName}
            </button>
          ) : null}
        </div>
        <div className="view-actions">
          <button
            type="button"
            className="view-send"
            data-testid="view-send"
            disabled={view.unsent === 0 || send.isPending}
            onClick={() => send.mutate()}
          >
            {view.unsent === 0 ? 'Nothing to send' : `Send ${view.unsent} to agent`}
          </button>
          <button
            type="button"
            className="view-icon-btn"
            aria-label="Delete view"
            title="Delete view"
            onClick={() => {
              if (window.confirm(`Delete "${view.title}"?`)) del.mutate();
            }}
          >
            <Trash2 size={14} aria-hidden />
          </button>
        </div>
      </header>
      {view.data.heading ? <p className="view-heading">{view.data.heading}</p> : null}
      <ul className="view-items" data-testid="view-items">
        {view.data.items.map((item) => (
          <ReviewItem
            key={item.id}
            item={item}
            mark={view.marks[item.id]}
            onVerdict={(verdict) => mark.mutate({ itemId: item.id, verdict })}
            onNote={(note) => mark.mutate({ itemId: item.id, note })}
          />
        ))}
      </ul>
      <footer className="view-foot">rev {view.rev}</footer>
    </div>
  );
}

function ReviewItem({
  item,
  mark,
  onVerdict,
  onNote,
}: {
  item: { id: string; title: string; detail?: string };
  mark: ViewMark | undefined;
  onVerdict: (v: 'yes' | 'no' | null) => void;
  onNote: (note: string) => void;
}): JSX.Element {
  const saved = mark?.note ?? '';
  const [draft, setDraft] = useState(saved);
  const [editing, setEditing] = useState(false);
  // Follow a note changed elsewhere, but never overwrite what is being typed.
  useEffect(() => {
    if (!editing) setDraft(saved);
  }, [saved, editing]);
  const verdict = mark?.verdict ?? null;
  return (
    <li className="view-item" data-testid="view-item" data-item-id={item.id}>
      <div className="view-item-text">
        <div className="view-item-title">{item.title}</div>
        {item.detail ? <div className="view-item-detail">{item.detail}</div> : null}
      </div>
      <div className="view-item-marks">
        <button
          type="button"
          className={`view-verdict${verdict === 'yes' ? ' is-yes' : ''}`}
          aria-pressed={verdict === 'yes'}
          data-testid="view-yes"
          onClick={() => onVerdict(verdict === 'yes' ? null : 'yes')}
        >
          Yes
        </button>
        <button
          type="button"
          className={`view-verdict${verdict === 'no' ? ' is-no' : ''}`}
          aria-pressed={verdict === 'no'}
          data-testid="view-no"
          onClick={() => onVerdict(verdict === 'no' ? null : 'no')}
        >
          No
        </button>
      </div>
      <textarea
        className="view-note"
        data-testid="view-note"
        rows={1}
        placeholder="Note"
        value={draft}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft !== saved) onNote(draft);
        }}
      />
    </li>
  );
}
