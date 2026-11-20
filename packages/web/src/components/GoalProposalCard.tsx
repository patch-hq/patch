// The card for a `patch_goal_propose` call: the agent suggests a goal (or an
// ordered sequence), the user edits it in place and accepts. Nothing is armed
// until Accept; what is armed is what is in the boxes (spec/04 § Goals).

import type { JSX } from 'react';
import { useState } from 'react';
import { Plus, Target, X } from 'lucide-react';
import type { GoalProposal } from '@patch/wire';
import { api } from '../api/rest.js';
import { getActiveWs } from '../api/ws.js';
import { sendMessage } from '../lib/sendQueue.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';

type Phase = 'open' | 'saving' | 'accepted' | 'dismissed';

export function GoalProposalCard({
  chatId,
  proposal,
}: {
  chatId: string;
  proposal: GoalProposal;
}): JSX.Element {
  const [goals, setGoals] = useState<string[]>([proposal.condition, ...proposal.then]);
  // After a reload the card has no memory: a chat already working toward this
  // condition has accepted it.
  const armed = useChatStore((s) => s.chats[chatId]?.goal ?? null);
  const [phase, setPhase] = useState<Phase>(armed === proposal.condition ? 'accepted' : 'open');
  const pushError = useUiStore((s) => s.pushError);
  const setGoal = useChatStore((s) => s.setGoal);

  const clean = goals.map((g) => g.trim()).filter((g) => g.length > 0);
  const edited = goals.join('\n') !== [proposal.condition, ...proposal.then].join('\n');

  async function accept(): Promise<void> {
    const [first, ...rest] = clean;
    if (first === undefined) return;
    const ws = getActiveWs();
    if (!ws) {
      pushError('not connected');
      return;
    }
    setPhase('saving');
    const plan = rest.length > 0 ? { then: rest } : {};
    try {
      await api.setGoal(chatId, first, plan);
    } catch (err) {
      setPhase('open');
      pushError('setting goal failed', undefined, (err as Error).message);
      return;
    }
    setGoal(chatId, first, plan);
    sendMessage(chatId, first, [], { send: (e) => ws.send(e) });
    setPhase('accepted');
  }

  const locked = phase !== 'open';
  return (
    <div
      className="goal-proposal"
      data-testid="goal-proposal"
      data-phase={phase}
      role="group"
      aria-label="goal proposal"
    >
      <div className="goal-proposal-head">
        <Target size={14} aria-hidden />
        <span>{goals.length > 1 ? 'Proposed goals' : 'Proposed goal'}</span>
        {phase === 'accepted' && (
          <span className="goal-proposal-state" data-testid="goal-proposal-state">
            {edited ? 'Accepted with edits' : 'Accepted'}
          </span>
        )}
        {phase === 'dismissed' && (
          <span className="goal-proposal-state" data-testid="goal-proposal-state">
            Dismissed
          </span>
        )}
      </div>
      <ol className="goal-proposal-list">
        {goals.map((g, i) => (
          <li key={i} className="goal-proposal-item">
            <span className="goal-proposal-n" aria-hidden>
              {i + 1}
            </span>
            <textarea
              data-testid="goal-proposal-text"
              aria-label={`Goal ${i + 1}`}
              rows={2}
              value={g}
              disabled={locked}
              onChange={(e) => setGoals(goals.map((x, j) => (j === i ? e.target.value : x)))}
            />
            {goals.length > 1 && !locked && (
              <button
                type="button"
                className="goal-proposal-remove"
                data-testid="goal-proposal-remove"
                aria-label={`Remove goal ${i + 1}`}
                onClick={() => setGoals(goals.filter((_, j) => j !== i))}
              >
                <X size={13} aria-hidden />
              </button>
            )}
          </li>
        ))}
      </ol>
      {proposal.why ? <p className="goal-proposal-why">{proposal.why}</p> : null}
      {!locked && (
        <div className="goal-proposal-actions">
          <button
            type="button"
            className="goal-proposal-add"
            data-testid="goal-proposal-add"
            onClick={() => setGoals([...goals, ''])}
          >
            <Plus size={13} aria-hidden /> Add goal
          </button>
          <span className="goal-proposal-spacer" />
          <button
            type="button"
            data-testid="goal-proposal-dismiss"
            onClick={() => setPhase('dismissed')}
          >
            Dismiss
          </button>
          <button
            type="button"
            className="goal-proposal-accept"
            data-testid="goal-proposal-accept"
            disabled={clean.length === 0}
            onClick={() => void accept()}
          >
            {edited ? 'Accept edited' : 'Accept'}
          </button>
        </div>
      )}
    </div>
  );
}
