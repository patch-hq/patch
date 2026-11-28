// The chat's standing "Needs you" bar, above the composer: the agent declared it
// is blocked on the user (`patch_ask_human`, a goal hold), and this says exactly
// what, in the words the agent gave. It is read straight off the chat's row, so
// it goes the moment the ask is resolved or the user replies.

import type { JSX } from 'react';
import { Hand } from 'lucide-react';
import { useChatStore } from '../stores/chatStore.js';
import { isAskOutstanding, pressAskDone } from '../lib/askDone.js';
import { ActionText } from './AskHumanCard.js';

export function NeedsYouBar({ chatId }: { chatId: string }): JSX.Element | null {
  const row = useChatStore((s) => s.chats[chatId]);
  if (!row || !isAskOutstanding(row) || !row.statusSummary) return null;
  return (
    <div className="needs-you-wrap">
      <div
        className="ask-human-card needs-you-bar"
        data-testid="needs-you-bar"
        role="group"
        aria-label="needs you"
      >
        <Hand size={14} aria-hidden className="ask-human-icon" />
        <div className="ask-human-body">
          <p className="ask-human-why">Needs you</p>
          <p className="ask-human-task" data-testid="needs-you-text">
            <ActionText text={row.statusSummary} />
          </p>
        </div>
        <button
          type="button"
          className="ask-human-done"
          data-testid="needs-you-done"
          onClick={() => pressAskDone(chatId)}
        >
          Done
        </button>
      </div>
    </div>
  );
}
