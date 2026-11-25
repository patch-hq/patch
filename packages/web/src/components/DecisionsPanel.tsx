// DecisionsPanel — questions a long-running chat has parked for the user while
// it carries on. Pinned above the composer like the task list, but unlike a
// permission or an ask-human it never blocks: each card carries the full
// context needed to answer without scrolling the transcript, and stays until
// answered. spec/14 § Main chat panel — Decisions.

import type { JSX } from 'react';
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ChatDecision } from '../stores/types.js';

function DecisionCard({
  decision,
  onAnswer,
}: {
  decision: ChatDecision;
  onAnswer: (id: string, answer: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const long = decision.context.length > 160;
  return (
    <li className="decision-card" data-testid="decision-card">
      <p className="decision-question" data-testid="decision-question">
        {decision.question}
      </p>
      <p
        className={`decision-context${long && !open ? ' decision-context-clamped' : ''}`}
        data-testid="decision-context"
      >
        {decision.context}
      </p>
      {long ? (
        <button
          type="button"
          className="decision-toggle"
          data-testid="decision-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
          {open ? 'Less context' : 'Full context'}
        </button>
      ) : null}
      {decision.options && decision.options.length > 0 ? (
        <div className="decision-options" role="group" aria-label="Answers">
          {decision.options.map((o) => (
            <button
              key={o}
              type="button"
              className="decision-option"
              data-testid="decision-option"
              disabled={decision.sending}
              onClick={() => onAnswer(decision.id, o)}
            >
              {o}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="decision-free"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() !== '') onAnswer(decision.id, text.trim());
        }}
      >
        <input
          className="decision-input"
          data-testid="decision-input"
          aria-label="Your answer"
          placeholder={decision.options?.length ? 'Or say something else' : 'Your answer'}
          value={text}
          disabled={decision.sending}
          onChange={(e) => setText(e.target.value)}
        />
        {text.trim() !== '' || decision.sending ? (
          <button
            type="submit"
            className="task-done-btn"
            data-testid="decision-send"
            disabled={decision.sending}
          >
            {decision.sending ? 'Sending' : 'Send'}
          </button>
        ) : null}
      </form>
    </li>
  );
}

export function DecisionsPanel({
  decisions,
  onAnswer,
}: {
  decisions: ChatDecision[];
  onAnswer: (id: string, answer: string) => void;
}): JSX.Element | null {
  if (decisions.length === 0) return null;
  return (
    <section className="decisions-panel" data-testid="decisions-panel" aria-label="Decisions">
      <div className="decisions-head">
        <span>Decisions</span>
        <span className="decisions-count" data-testid="decisions-count">
          {decisions.length}
        </span>
      </div>
      <ul className="decisions-list">
        {decisions.map((d) => (
          <DecisionCard key={d.id} decision={d} onAnswer={onAnswer} />
        ))}
      </ul>
    </section>
  );
}
