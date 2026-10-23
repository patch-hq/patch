// Typing into an open question tells the host, so its countdown restarts
// while the user is still writing (a long Other answer must not time out).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QuestionCard } from '../components/QuestionCard.js';
import type { ChatEventEntry } from '../stores/chatStore.js';

const entry: ChatEventEntry = {
  seq: 1,
  kind: 'permission',
  tool: 'AskUserQuestion',
  requestId: 'req-act',
  toolArgs: {
    questions: [
      {
        header: 'Rule',
        question: 'Which rule?',
        multiSelect: false,
        options: [{ label: 'A', description: 'a' }],
      },
    ],
  },
  at: 0,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('question card activity', () => {
  it('pings on interaction, throttled, and not on mount', () => {
    vi.useFakeTimers();
    const onActivity = vi.fn();
    render(
      <QuestionCard entry={entry} onAnswer={vi.fn()} onCancel={vi.fn()} onActivity={onActivity} />,
    );
    expect(onActivity).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Other'));
    expect(onActivity).toHaveBeenCalledTimes(1);

    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'abc' } });
    expect(onActivity).toHaveBeenCalledTimes(1); // throttled

    vi.advanceTimersByTime(6_000);
    fireEvent.change(box, { target: { value: 'abcd' } });
    expect(onActivity).toHaveBeenCalledTimes(2);
  });

  it('does not ping once resolved', () => {
    const onActivity = vi.fn();
    const { rerender } = render(
      <QuestionCard entry={entry} onAnswer={vi.fn()} onCancel={vi.fn()} onActivity={onActivity} />,
    );
    rerender(
      <QuestionCard
        entry={{
          ...entry,
          permissionResolved: 'approve',
          permissionAnswers: { 'Which rule?': 'A' },
        }}
        onAnswer={vi.fn()}
        onCancel={vi.fn()}
        onActivity={onActivity}
      />,
    );
    expect(onActivity).not.toHaveBeenCalled();
  });
});
