// Typing into an open question tells the host, so its countdown restarts
// while the user is still writing (a long Other answer must not time out).

import { StrictMode } from 'react';
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
    // the throttled keystroke is sent at the end of the gap, not dropped
    expect(onActivity).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(6_000);
    fireEvent.change(box, { target: { value: 'abcd' } });
    expect(onActivity).toHaveBeenCalledTimes(3);
  });

  it('keeps a 5s window alive under continuous typing', () => {
    vi.useFakeTimers();
    const onActivity = vi.fn();
    const short = { ...entry, permissionExpiry: { at: Date.now() + 5_000, windowMs: 5_000 } };
    render(
      <QuestionCard entry={short} onAnswer={vi.fn()} onCancel={vi.fn()} onActivity={onActivity} />,
    );
    fireEvent.click(screen.getByText('Other'));
    const box = screen.getByRole('textbox');
    const pingTimes: number[] = [];
    onActivity.mockImplementation(() => pingTimes.push(Date.now()));
    const start = Date.now();
    for (let i = 0; i < 40; i++) {
      fireEvent.change(box, { target: { value: 'x'.repeat(i + 1) } });
      vi.advanceTimersByTime(250);
    }
    vi.advanceTimersByTime(2_000);
    const stamps = [start, ...pingTimes];
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]! - stamps[i - 1]!).toBeLessThan(5_000);
    }
    // last keystroke at ~10s is followed by a ping within a third of the window
    expect(pingTimes[pingTimes.length - 1]! - start).toBeGreaterThanOrEqual(9_750);
  });

  it('sends no spurious ping under StrictMode mount', () => {
    const onActivity = vi.fn();
    render(
      <StrictMode>
        <QuestionCard entry={entry} onAnswer={vi.fn()} onCancel={vi.fn()} onActivity={onActivity} />
      </StrictMode>,
    );
    expect(onActivity).not.toHaveBeenCalled();
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
