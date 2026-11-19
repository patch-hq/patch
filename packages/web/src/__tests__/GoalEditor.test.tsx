// spec/04 § Goals, spec/14 § Goals — the goal editor sets a goal together with
// the goals that follow it and the two cadences, and the goal row shows them.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach } from 'vitest';
import { GoalEditor } from '../components/GoalEditor.js';
import { GoalBanner } from '../components/GoalBanner.js';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import type { ChatRow } from '../stores/types.js';

vi.mock('../api/rest.js', () => ({ api: { setGoal: vi.fn(async () => undefined) } }));

const emptyPlan = { then: [], remindEvery: null, checkInEvery: null };

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe('GoalEditor', () => {
  it('saves a goal with follow-on goals and both cadences', () => {
    const onSave = vi.fn();
    render(<GoalEditor goal={null} plan={emptyPlan} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('goal-edit-input'), { target: { value: 'Ship it' } });
    fireEvent.click(screen.getByTestId('goal-then-add'));
    fireEvent.change(screen.getByTestId('goal-then-0'), { target: { value: 'Write the notes' } });
    fireEvent.click(screen.getByTestId('goal-then-add'));
    fireEvent.change(screen.getByTestId('goal-then-1'), { target: { value: '   ' } });
    fireEvent.change(screen.getByTestId('goal-remind-unit'), { target: { value: 'turns' } });
    fireEvent.change(screen.getByTestId('goal-remind-n'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('goal-checkin-unit'), { target: { value: 'minutes' } });
    fireEvent.change(screen.getByTestId('goal-checkin-n'), { target: { value: '15' } });
    fireEvent.click(screen.getByTestId('goal-edit-save'));
    expect(onSave).toHaveBeenCalledWith({
      goal: 'Ship it',
      plan: {
        then: ['Write the notes'],
        remindEvery: { unit: 'turns', n: 3 },
        checkInEvery: { unit: 'minutes', n: 15 },
      },
    });
  });

  it('Set goal and snooze saves the draft through its own handler, only when setting', () => {
    const onSave = vi.fn();
    const onSnooze = vi.fn();
    const onClose = vi.fn();
    render(
      <GoalEditor
        goal={null}
        plan={emptyPlan}
        onSave={onSave}
        onSaveAndSnooze={onSnooze}
        onClose={onClose}
      />,
    );
    const btn = screen.getByTestId('goal-edit-save-snooze') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('goal-edit-input'), { target: { value: 'Ship it' } });
    fireEvent.click(btn);
    expect(onSnooze).toHaveBeenCalledWith({ goal: 'Ship it', plan: {} });
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('no snooze button when editing an existing goal', () => {
    render(
      <GoalEditor
        goal="Ship it"
        plan={emptyPlan}
        onSave={vi.fn()}
        onSaveAndSnooze={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('goal-edit-save-snooze')).toBeNull();
  });

  it('a plain goal saves with no plan at all', () => {
    const onSave = vi.fn();
    render(<GoalEditor goal={null} plan={emptyPlan} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('goal-edit-input'), { target: { value: 'Ship it' } });
    fireEvent.click(screen.getByTestId('goal-edit-save'));
    expect(onSave).toHaveBeenCalledWith({ goal: 'Ship it', plan: {} });
  });

  it('removing a follow-on goal, or turning a cadence off, is a change', () => {
    const onSave = vi.fn();
    render(
      <GoalEditor
        goal="Ship it"
        plan={{
          then: ['A', 'B'],
          remindEvery: { unit: 'turns', n: 2 },
          checkInEvery: null,
        }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('goal-then-remove-0'));
    fireEvent.change(screen.getByTestId('goal-remind-unit'), { target: { value: 'never' } });
    fireEvent.click(screen.getByTestId('goal-edit-save'));
    expect(onSave).toHaveBeenCalledWith({
      goal: 'Ship it',
      plan: { then: ['B'], remindEvery: null, checkInEvery: null },
    });
  });

  it('saving with nothing changed calls nothing and closes', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<GoalEditor goal="Ship it" plan={emptyPlan} onSave={onSave} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('goal-edit-save'));
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('emptying the text clears the goal', () => {
    const onSave = vi.fn();
    render(<GoalEditor goal="Ship it" plan={emptyPlan} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('goal-edit-input'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('goal-edit-save'));
    expect(onSave).toHaveBeenCalledWith({ goal: null, plan: {} });
  });
});

describe('GoalBanner — the plan', () => {
  function row(): ChatRow {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        hostId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'x',
        folder: 'f',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 0,
        goal: 'Ship it',
        goalProgress: {
          startedAt: Date.now(),
          turnsEvaluated: 3,
          tokensSpent: 0,
          lastVerdict: 'not_met',
          lastReason: 'tests red',
          lastCheckIn: { at: Date.now(), status: 'off_track', reason: 'Same test failing' },
        },
        goalQueue: ['Write the notes', 'Tag it'],
        goalReminderEvery: { unit: 'turns', n: 4 },
        goalCheckInEvery: { unit: 'minutes', n: 1 },
      } as never,
    ]);
    return useChatStore.getState().chats['c1']!;
  }

  it('shows how many goals follow, and the plan and latest check-in when opened', () => {
    render(<GoalBanner row={row()} />);
    expect(screen.getByTestId('goal-banner')).toHaveTextContent('2 to follow');
    fireEvent.click(screen.getByTestId('goal-pill'));
    expect(screen.getByTestId('goal-banner-plan')).toHaveTextContent(
      'Then: Write the notes → Tag it. Reminds every 4 turns. Checks in every 1 minute.',
    );
    expect(screen.getByTestId('goal-banner-reason')).toHaveTextContent(
      'Check-in off track: Same test failing',
    );
  });

  it('editing the plan posts it with the goal', async () => {
    render(<GoalBanner row={row()} />);
    fireEvent.click(screen.getByTestId('goal-banner-text'));
    fireEvent.click(screen.getByTestId('goal-then-remove-1'));
    fireEvent.click(screen.getByTestId('goal-edit-save'));
    await waitFor(() =>
      expect(api.setGoal).toHaveBeenCalledWith('c1', 'Ship it', {
        then: ['Write the notes'],
        remindEvery: { unit: 'turns', n: 4 },
        checkInEvery: { unit: 'minutes', n: 1 },
      }),
    );
    expect(useChatStore.getState().chats['c1']?.goalQueue).toEqual(['Write the notes']);
  });

  it('puts the plan back, and says so, when the save fails', async () => {
    (api.setGoal as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    render(<GoalBanner row={row()} />);
    fireEvent.click(screen.getByTestId('goal-banner-text'));
    fireEvent.click(screen.getByTestId('goal-then-remove-0'));
    fireEvent.click(screen.getByTestId('goal-edit-save'));
    await waitFor(() =>
      expect(useChatStore.getState().chats['c1']?.goalQueue).toEqual(['Write the notes', 'Tag it']),
    );
  });
});
