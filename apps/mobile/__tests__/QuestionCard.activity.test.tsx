// "Still typing" pings (parity with `packages/web/src/__tests__/QuestionCard.activity.test.tsx`):
// throttled but trailing-edge, so a short expiry window survives steady typing.

import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { renderRN, findHost, byTestId, actSync } from './testUtils/render';
import { QuestionCard } from '../src/components/QuestionCard';
import type { ChatEventEntry } from '../src/stores/chatStore';

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
  permissionExpiry: { at: 5_000, windowMs: 5_000 },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('question card activity (mobile)', () => {
  it('keeps a 5s window alive under continuous typing, with no ping on mount', () => {
    const onActivity = vi.fn();
    const r = renderRN(
      <QuestionCard entry={entry} onAnswer={vi.fn()} onCancel={vi.fn()} onActivity={onActivity} />,
    );
    expect(onActivity).not.toHaveBeenCalled();

    actSync(() => findHost(r.root, byTestId('question-other')).props.onPress());
    const pingTimes: number[] = [];
    onActivity.mockImplementation(() => pingTimes.push(Date.now()));
    for (let i = 0; i < 40; i++) {
      actSync(() =>
        findHost(r.root, byTestId('question-other-input')).props.onChangeText('x'.repeat(i + 1)),
      );
      actSync(() => vi.advanceTimersByTime(250));
    }
    actSync(() => vi.advanceTimersByTime(2_000));

    expect(pingTimes.length).toBeGreaterThan(4);
    const stamps = [0, ...pingTimes];
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]! - stamps[i - 1]!).toBeLessThan(5_000);
    }
    expect(pingTimes[pingTimes.length - 1]!).toBeGreaterThanOrEqual(9_750);
  });
});
