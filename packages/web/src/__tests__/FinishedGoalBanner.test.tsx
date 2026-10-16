import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FinishedGoalBanner } from '../components/GoalBanner.js';
import type { ChatRow } from '../stores/types.js';

const long =
  "Other people's data was not exposed to the agent anywhere in this run, including logs, caches and transcripts";
const lastGoal = {
  condition: long,
  startedAt: 0,
  endedAt: 9 * 60_000,
  turns: 3,
  tokens: 8200,
  outcome: 'met' as const,
  reason: 'All checks pass',
};
const row = (o: Partial<ChatRow> = {}): ChatRow =>
  ({ chatId: 'c1', goal: null, lastGoal, ...o }) as ChatRow;

describe('FinishedGoalBanner', () => {
  beforeEach(() => localStorage.clear());

  it('shows the full goal text and metrics, untruncated', () => {
    render(<FinishedGoalBanner row={row()} />);
    expect(screen.getByTestId('finished-goal-summary')).toHaveTextContent(`Goal met: ${long}`);
    expect(screen.getByTestId('finished-goal-detail')).toHaveTextContent(
      '9m · 3 turns · 8.2k tokens · All checks pass',
    );
  });

  it('is hidden with no finished goal or while a goal is active', () => {
    const { rerender } = render(<FinishedGoalBanner row={row({ lastGoal: null })} />);
    expect(screen.queryByTestId('finished-goal-banner')).not.toBeInTheDocument();
    rerender(<FinishedGoalBanner row={row({ goal: 'going' })} />);
    expect(screen.queryByTestId('finished-goal-banner')).not.toBeInTheDocument();
  });

  it('dismisses, stays dismissed on remount, and returns for the next finished goal', () => {
    const { unmount } = render(<FinishedGoalBanner row={row()} />);
    fireEvent.click(screen.getByTestId('finished-goal-dismiss'));
    expect(screen.queryByTestId('finished-goal-banner')).not.toBeInTheDocument();
    unmount();
    const r = render(<FinishedGoalBanner row={row()} />);
    expect(screen.queryByTestId('finished-goal-banner')).not.toBeInTheDocument();
    r.rerender(
      <FinishedGoalBanner row={row({ lastGoal: { ...lastGoal, endedAt: 99 * 60_000 } })} />,
    );
    expect(screen.getByTestId('finished-goal-banner')).toBeInTheDocument();
  });

  it('labels impossible distinctly', () => {
    render(<FinishedGoalBanner row={row({ lastGoal: { ...lastGoal, outcome: 'impossible' } })} />);
    expect(screen.getByTestId('finished-goal-summary')).toHaveTextContent('Goal impossible');
  });
});
