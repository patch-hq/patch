// spec/04 § Goals, spec/15 § Chat detail → Status bars — the phone's goal bar
// shows the goals queued after the active one and edits them and the two
// cadences, sending the whole plan with the goal, like web's goal editor.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, findHost, queryHost, byTestId, hasText, actSync } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';

const apiMocks = { setGoal: vi.fn(async (..._a: unknown[]) => undefined) };
vi.mock('../src/api/rest', () => ({ api: apiMocks }));

const { GoalBar } = await import('../src/components/chatBars/GoalBar');

function Harness(): React.ReactElement | null {
  const row = useChatStore((s) => s.chats['c1']);
  return row ? <GoalBar row={row} /> : null;
}

function seed(extra: Record<string, unknown> = {}): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'Chat',
      hostId: 'd1',
      folder: '/home/tom/p',
      activity: 'idle',
      permissionMode: 'auto',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
      goal: 'Ship it',
      ...extra,
    },
  ]);
}
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};
const open = (r: ReturnType<typeof renderRN>): void =>
  actSync(() => findHost(r.root, byTestId('goal-bar-summary')).props.onPress());

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
});

describe('Goal bar — the plan', () => {
  it('says how many goals follow, and lists them when opened', () => {
    seed({ goalQueue: ['Write notes', 'Tag it'] });
    const r = renderRN(<Harness />);
    expect(hasText(findHost(r.root, byTestId('goal-bar-summary')), '2 to follow')).toBe(true);
    expect(queryHost(r.root, byTestId('goal-then-0'))).toBeNull();
    open(r);
    expect(hasText(findHost(r.root, byTestId('goal-then-0')), 'Then 1: Write notes')).toBe(true);
    expect(hasText(findHost(r.root, byTestId('goal-then-1')), 'Then 2: Tag it')).toBe(true);
  });

  it('adding a goal to follow sends the whole plan with the goal', async () => {
    seed({ goalReminderEvery: { unit: 'turns', n: 3 } });
    const r = renderRN(<Harness />);
    open(r);
    actSync(() => findHost(r.root, byTestId('goal-then-input')).props.onChangeText('Write notes'));
    actSync(() => findHost(r.root, byTestId('goal-then-input')).props.onSubmitEditing());
    await flush();
    expect(apiMocks.setGoal).toHaveBeenCalledWith('c1', 'Ship it', {
      then: ['Write notes'],
      remindEvery: { unit: 'turns', n: 3 },
      checkInEvery: null,
    });
    expect(useChatStore.getState().chats['c1']!.goalQueue).toEqual(['Write notes']);
  });

  it('removing one keeps the rest; removing the last of a bare plan sends no plan', async () => {
    seed({ goalQueue: ['A', 'B'] });
    const r = renderRN(<Harness />);
    open(r);
    actSync(() => findHost(r.root, byTestId('goal-then-remove-0')).props.onPress());
    await flush();
    expect(apiMocks.setGoal).toHaveBeenLastCalledWith('c1', 'Ship it', {
      then: ['B'],
      remindEvery: null,
      checkInEvery: null,
    });
    actSync(() => findHost(r.root, byTestId('goal-then-remove-0')).props.onPress());
    await flush();
    expect(apiMocks.setGoal).toHaveBeenLastCalledWith('c1', 'Ship it');
  });

  it('picks a reminder and a check-in cadence', async () => {
    seed();
    const r = renderRN(<Harness />);
    open(r);
    actSync(() => findHost(r.root, byTestId('goal-remind-turns-10')).props.onPress());
    await flush();
    actSync(() => findHost(r.root, byTestId('goal-checkin-minutes-15')).props.onPress());
    await flush();
    expect(apiMocks.setGoal).toHaveBeenLastCalledWith('c1', 'Ship it', {
      then: [],
      remindEvery: { unit: 'turns', n: 10 },
      checkInEvery: { unit: 'minutes', n: 15 },
    });
  });

  it('editing the goal text keeps the plan', async () => {
    seed({ goalQueue: ['A'], goalCheckInEvery: { unit: 'turns', n: 3 } });
    const r = renderRN(<Harness />);
    open(r);
    actSync(() => findHost(r.root, byTestId('goal-bar-text')).props.onPress());
    actSync(() =>
      findHost(r.root, byTestId('goal-bar-text-input')).props.onChangeText('Ship it now'),
    );
    actSync(() => findHost(r.root, byTestId('goal-bar-text-input')).props.onSubmitEditing());
    await flush();
    expect(apiMocks.setGoal).toHaveBeenCalledWith('c1', 'Ship it now', {
      then: ['A'],
      remindEvery: null,
      checkInEvery: { unit: 'turns', n: 3 },
    });
  });

  it('a refused write puts the plan back and says so', async () => {
    seed({ goalQueue: ['A'] });
    apiMocks.setGoal.mockRejectedValueOnce(new Error('host offline'));
    const r = renderRN(<Harness />);
    open(r);
    actSync(() => findHost(r.root, byTestId('goal-then-remove-0')).props.onPress());
    await flush();
    expect(useChatStore.getState().chats['c1']!.goalQueue).toEqual(['A']);
    expect(useUiStore.getState().errors.length).toBeGreaterThan(0);
  });
});
