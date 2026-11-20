import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { parseGoalPropose } from '@patch/wire';
import { GoalProposalCard } from '../components/GoalProposalCard.js';
import { api } from '../api/rest.js';

vi.mock('../api/rest.js', () => ({ api: { setGoal: vi.fn(async () => undefined) } }));
const send = vi.fn();
vi.mock('../api/ws.js', () => ({ getActiveWs: () => ({ send }) }));
vi.mock('../lib/sendQueue.js', () => ({ sendMessage: vi.fn() }));
import { sendMessage } from '../lib/sendQueue.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const proposal = { condition: 'Ship A', then: ['Ship B'] };

describe('parseGoalPropose', () => {
  it('rejects a missing condition and drops blank follow-ups', () => {
    expect(parseGoalPropose({})).toBeNull();
    expect(parseGoalPropose({ condition: 'x', then: ['', 'y', 3] })).toEqual({
      condition: 'x',
      then: ['y'],
    });
  });
});

describe('GoalProposalCard', () => {
  it('accepts the edited sequence and sends the first goal as a turn', async () => {
    render(<GoalProposalCard chatId="c1" proposal={proposal} />);
    const boxes = screen.getAllByTestId('goal-proposal-text');
    fireEvent.change(boxes[0]!, { target: { value: 'Ship A fast' } });
    fireEvent.click(screen.getByTestId('goal-proposal-accept'));
    await waitFor(() => expect(screen.getByTestId('goal-proposal-state')).toBeTruthy());
    expect(api.setGoal).toHaveBeenCalledWith('c1', 'Ship A fast', { then: ['Ship B'] });
    expect(sendMessage).toHaveBeenCalledWith('c1', 'Ship A fast', [], expect.anything());
    expect(screen.getByTestId('goal-proposal-state').textContent).toBe('Accepted with edits');
  });

  it('dismiss sets nothing', () => {
    render(<GoalProposalCard chatId="c1" proposal={proposal} />);
    fireEvent.click(screen.getByTestId('goal-proposal-dismiss'));
    expect(api.setGoal).not.toHaveBeenCalled();
    expect(screen.getByTestId('goal-proposal-state').textContent).toBe('Dismissed');
  });

  it('removing a goal drops it from the sequence', async () => {
    render(<GoalProposalCard chatId="c1" proposal={proposal} />);
    fireEvent.click(screen.getAllByTestId('goal-proposal-remove')[1]!);
    fireEvent.click(screen.getByTestId('goal-proposal-accept'));
    await waitFor(() => expect(api.setGoal).toHaveBeenCalledWith('c1', 'Ship A', {}));
  });
});
