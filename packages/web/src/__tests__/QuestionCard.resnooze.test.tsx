// Answering a question that woke a snoozed chat: "Send answer and snooze"
// answers and snoozes again; "Send answer" answers alone; Cancel does neither.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QuestionCard } from '../components/QuestionCard.js';
import { resnoozeTarget } from '../lib/resnoozeAfterAnswer.js';
import { SNOOZE_UNTIL_COMPLETE } from '@patch/wire';
import type { ChatEventEntry } from '../stores/chatStore.js';
import type { ChatRow } from '../stores/types.js';

const entry: ChatEventEntry = {
  seq: 1,
  kind: 'permission',
  tool: 'AskUserQuestion',
  requestId: 'req-1',
  toolArgs: {
    questions: [
      {
        header: 'Pick',
        question: 'Which?',
        multiSelect: false,
        options: [
          { label: 'A', description: 'a' },
          { label: 'B', description: 'b' },
        ],
      },
    ],
  },
  at: 0,
};

afterEach(cleanup);

describe('QuestionCard resnooze', () => {
  it('offers Send answer and snooze only when asked to, and routes the answer to it', () => {
    const onAnswer = vi.fn();
    const onAnswerAndSnooze = vi.fn();
    render(
      <QuestionCard
        entry={entry}
        onAnswer={onAnswer}
        onCancel={vi.fn()}
        onAnswerAndSnooze={onAnswerAndSnooze}
      />,
    );
    const btn = screen.getByTestId('question-submit-snooze') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(screen.getByText('A'));
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onAnswerAndSnooze).toHaveBeenCalledWith('req-1', { 'Which?': 'A' });
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('plain Send answer does not snooze', () => {
    const onAnswer = vi.fn();
    const onAnswerAndSnooze = vi.fn();
    render(
      <QuestionCard
        entry={entry}
        onAnswer={onAnswer}
        onCancel={vi.fn()}
        onAnswerAndSnooze={onAnswerAndSnooze}
      />,
    );
    fireEvent.click(screen.getByText('B'));
    fireEvent.click(screen.getByTestId('question-submit'));
    expect(onAnswer).toHaveBeenCalledWith('req-1', { 'Which?': 'B' });
    expect(onAnswerAndSnooze).not.toHaveBeenCalled();
  });

  it('has no snooze button without the handler', () => {
    render(<QuestionCard entry={entry} onAnswer={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId('question-submit-snooze')).toBeNull();
  });
});

function row(over: Partial<ChatRow>): ChatRow {
  return { snoozedUntil: null, snoozeRecords: [], ...over } as ChatRow;
}
const rec = (until: number, outcome: string, endedAt: number | null = 2000) => ({
  setId: 's',
  startedAt: 1000,
  startSeq: 0,
  until,
  endedAt,
  outcome: { kind: outcome },
  backCleared: false,
});

describe('resnoozeTarget', () => {
  const now = 10_000;
  it('repeats the old snooze length from now when it ended waiting on the user', () => {
    const r = row({ snoozeRecords: [rec(61_000, 'waiting')] as never });
    expect(resnoozeTarget(r, now)).toBe(now + 60_000);
  });
  it('repeats until-complete as until-complete', () => {
    const r = row({ snoozeRecords: [rec(SNOOZE_UNTIL_COMPLETE, 'waiting')] as never });
    expect(resnoozeTarget(r, now)).toBe(SNOOZE_UNTIL_COMPLETE);
  });
  it('is null when the chat did not wake for the user, is still snoozed, or never snoozed', () => {
    expect(
      resnoozeTarget(row({ snoozeRecords: [rec(61_000, 'finished')] as never }), now),
    ).toBeNull();
    expect(
      resnoozeTarget(
        row({ snoozedUntil: now + 5, snoozeRecords: [rec(61_000, 'waiting')] as never }),
        now,
      ),
    ).toBeNull();
    expect(resnoozeTarget(row({}), now)).toBeNull();
    expect(resnoozeTarget(undefined, now)).toBeNull();
  });
});
