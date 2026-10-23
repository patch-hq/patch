// An answer the host refused as expired must not read as delivered.
//
// The card resolves optimistically the moment Send answer is pressed; if the
// question's window had already run out (a long free-text answer), the host's
// echo is a deny and the store marks the entry `permissionCancelled`. The card
// used to ignore that flag and keep saying "Answered" while the agent was told
// "timed out" — the answer looked submitted and never was.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QuestionCard } from '../components/QuestionCard.js';
import type { ChatEventEntry } from '../stores/chatStore.js';

const QUESTION = 'Which rule do you want?';

function entry(over: Partial<ChatEventEntry> = {}): ChatEventEntry {
  return {
    seq: 1,
    kind: 'permission',
    tool: 'AskUserQuestion',
    requestId: 'req-lost',
    toolArgs: {
      questions: [
        {
          header: 'Rule',
          question: QUESTION,
          multiSelect: false,
          options: [{ label: 'A', description: 'a' }],
        },
      ],
    },
    at: 0,
    permissionResolved: 'approve',
    permissionAnswers: { [QUESTION]: 'a long typed answer' },
    ...over,
  };
}

afterEach(cleanup);

describe('question card outcome', () => {
  it('says Answered when the host accepted the answer', () => {
    render(<QuestionCard entry={entry()} onAnswer={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('permission-outcome').textContent).toBe('Answered');
  });

  it('says the answer was not received when the host denied it after the optimistic resolve', () => {
    render(
      <QuestionCard
        entry={entry({ permissionCancelled: true })}
        onAnswer={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('permission-outcome').textContent).toBe(
      'Not received: the question had timed out',
    );
  });
});
