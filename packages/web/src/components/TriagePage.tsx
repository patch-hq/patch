// TriagePage — experimental (spec/14 § Triage). One chat at a time: the
// agent's last message in full, a box to answer it, Send. Sending marks the
// chat read, hands the reply to the agent and moves straight on to the next
// chat waiting; a chat that finishes while you work joins the end.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useChatStore } from '../stores/chatStore.js';
import { sendMessage } from '../lib/sendQueue.js';
import { lastAssistantMessage, triageQueue } from '../lib/triageQueue.js';
import { deriveChatTitle } from '../lib/chatTitle.js';
import { Markdown } from './Markdown.js';
import { NavHistoryControls } from './NavHistoryControls.js';
import type { PatchWs } from '../api/ws.js';

export function TriagePage({ ws }: { ws: PatchWs | null }): JSX.Element {
  const chats = useChatStore((s) => s.chats);
  const timelines = useChatStore((s) => s.timelines);
  const [answered, setAnswered] = useState<ReadonlyMap<string, number>>(new Map());
  const [draft, setDraft] = useState('');
  const queue = useMemo(() => triageQueue(chats, answered), [chats, answered]);
  const current = queue[0];
  const currentId = current?.chatId;
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The transcript of a chat nobody has opened is not loaded yet; ask for it.
  useEffect(() => {
    if (currentId && ws) ws.requestHistory(currentId);
  }, [currentId, ws]);

  // A new card starts with an empty box, focused.
  useEffect(() => {
    setDraft('');
    inputRef.current?.focus();
  }, [currentId]);

  const message = currentId ? lastAssistantMessage(timelines[currentId]) : null;

  function send(): void {
    const text = draft.trim();
    if (!current || !ws || text === '') return;
    sendMessage(current.chatId, text, [], { send: (e) => ws.send(e) });
    useChatStore.getState().markRead(current.chatId);
    const seq = useChatStore.getState().chats[current.chatId]?.lastSeq ?? current.lastSeq;
    setAnswered((prev) => new Map(prev).set(current.chatId, seq));
  }

  return (
    <main className="triage-route" data-testid="triage-route">
      <header className="route-head">
        <div className="route-head-title">
          <NavHistoryControls />
        </div>
        <span className="triage-count" data-testid="triage-count">
          {queue.length} waiting
        </span>
      </header>
      {current ? (
        <section className="triage-card" data-testid="triage-card" data-chat-id={current.chatId}>
          <h2 className="triage-title" data-testid="triage-title">
            {deriveChatTitle(current.name ?? null)}
          </h2>
          <div className="triage-message" data-testid="triage-message">
            {message === null ? (
              <p className="triage-loading">
                {timelines[current.chatId] ? 'No message from the agent yet.' : 'Loading…'}
              </p>
            ) : (
              <Markdown content={message} />
            )}
          </div>
          <form
            className="triage-reply"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <textarea
              ref={inputRef}
              data-testid="triage-input"
              aria-label="Reply"
              placeholder="Reply…"
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button
              type="submit"
              className="primary-btn"
              data-testid="triage-send"
              disabled={draft.trim() === '' || !ws}
            >
              Send
            </button>
          </form>
        </section>
      ) : (
        <p className="triage-empty" data-testid="triage-empty">
          Nothing waiting.
        </p>
      )}
    </main>
  );
}
