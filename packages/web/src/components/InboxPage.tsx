// InboxPage — experimental. A home page of cards: questions agents put to the
// user (a concise prompt with options, yes/no by default; the answer goes back
// to the agent so nobody has to open the chat) and reports from jobs. A card
// stays until it is ticked off; answering a question ticks it.

import type { JSX } from 'react';
import { Check } from 'lucide-react';
import { useInboxStore, type InboxCard } from '../stores/inboxStore.js';
import { relativeTime } from '../lib/relativeTime.js';
import { Markdown } from './Markdown.js';
import { NavHistoryControls } from './NavHistoryControls.js';

function Card({ card }: { card: InboxCard }): JSX.Element {
  const answer = useInboxStore((s) => s.answer);
  const tick = useInboxStore((s) => s.tick);
  return (
    <article
      className={`inbox-card${card.done ? ' is-done' : ''}`}
      data-testid={`inbox-card-${card.id}`}
      data-kind={card.kind}
    >
      <header className="inbox-card-head">
        <span className="inbox-chip">{card.kind === 'question' ? 'Question' : 'Report'}</span>
        <span className="inbox-from">{card.from}</span>
        <span className="inbox-when">{relativeTime(card.at)}</span>
      </header>
      {card.kind === 'question' ? (
        <>
          <p className="inbox-prompt">{card.prompt}</p>
          {card.done ? (
            <p className="inbox-answered">Answered: {card.answer}</p>
          ) : (
            <div className="inbox-options">
              {card.options.map((o) => (
                <button
                  key={o}
                  type="button"
                  className={o === card.defaultOption ? 'primary-btn' : 'secondary-btn'}
                  data-testid={`inbox-option-${card.id}-${o}`}
                  onClick={() => answer(card.id, o)}
                >
                  {o}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <h2 className="inbox-title">{card.title}</h2>
          <div className="inbox-body">
            <Markdown content={card.body} />
          </div>
          {card.done ? null : (
            <button
              type="button"
              className="secondary-btn inbox-tick"
              data-testid={`inbox-tick-${card.id}`}
              onClick={() => tick(card.id)}
            >
              <Check size={14} aria-hidden /> Done
            </button>
          )}
        </>
      )}
    </article>
  );
}

export function InboxPage(): JSX.Element {
  const cards = useInboxStore((s) => s.cards);
  const open = cards.filter((c) => !c.done);
  const done = cards.filter((c) => c.done);
  return (
    <main className="inbox-route" data-testid="inbox-route">
      <header className="route-head">
        <div className="route-head-title">
          <NavHistoryControls />
        </div>
        <span className="inbox-count" data-testid="inbox-count">
          {open.length} waiting
        </span>
      </header>
      <div className="inbox-list">
        {open.length === 0 ? (
          <p className="inbox-empty" data-testid="inbox-empty">
            Nothing waiting.
          </p>
        ) : (
          open.map((c) => <Card key={c.id} card={c} />)
        )}
        {done.length > 0 ? (
          <section data-testid="inbox-done">
            <h2 className="jobs-section-head">
              Done<span className="pads-count">{done.length}</span>
            </h2>
            {done.map((c) => (
              <Card key={c.id} card={c} />
            ))}
          </section>
        ) : null}
      </div>
    </main>
  );
}
