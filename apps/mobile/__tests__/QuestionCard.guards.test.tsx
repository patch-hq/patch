// The question card's two guards: one decision per request however fast the
// taps come, and a countdown ring that is always a number.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderRN, findHost, findAllHost, byTestId, hasText } from './testUtils/render';
import { QuestionCard } from '../src/components/QuestionCard';
import type { ChatEventEntry } from '../src/stores/chatStore';

const NOW = 1_700_000_000_000;
const questions = [
  {
    header: 'Library',
    question: 'Which one?',
    multiSelect: false,
    options: [
      { label: 'a', description: 'the a' },
      { label: 'b', description: 'the b' },
    ],
  },
];
const entry = (over: Partial<ChatEventEntry> = {}): ChatEventEntry => ({
  seq: 1,
  kind: 'permission',
  tool: 'AskUserQuestion',
  requestId: 'req-1',
  toolArgs: { questions },
  at: 0,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('one decision per request', () => {
  it('two taps on Send before the card re-renders answer once', () => {
    const onAnswer = vi.fn();
    const r = renderRN(<QuestionCard entry={entry()} onAnswer={onAnswer} onCancel={vi.fn()} />);
    findAllHost(r.root, byTestId('question-option'))
      .find((o) => hasText(o, 'a'))!
      .props.onPress();
    const send = findHost(r.root, byTestId('question-submit')).props.onPress as () => void;
    send();
    send();
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('two taps on Cancel cancel once, and a Cancel after an answer is not a second decision', () => {
    const onCancel = vi.fn();
    const onAnswer = vi.fn();
    const r = renderRN(<QuestionCard entry={entry()} onAnswer={onAnswer} onCancel={onCancel} />);
    const cancel = findHost(r.root, byTestId('question-cancel')).props.onPress as () => void;
    cancel();
    cancel();
    expect(onCancel).toHaveBeenCalledTimes(1);

    findAllHost(r.root, byTestId('question-option'))
      .find((o) => hasText(o, 'a'))!
      .props.onPress();
    (findHost(r.root, byTestId('question-submit')).props.onPress as () => void)();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('a different request is a fresh decision', () => {
    const onCancel = vi.fn();
    const r = renderRN(<QuestionCard entry={entry()} onAnswer={vi.fn()} onCancel={onCancel} />);
    (findHost(r.root, byTestId('question-cancel')).props.onPress as () => void)();
    r.update(
      <QuestionCard entry={entry({ requestId: 'req-2' })} onAnswer={vi.fn()} onCancel={onCancel} />,
    );
    (findHost(r.root, byTestId('question-cancel')).props.onPress as () => void)();
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});

describe('the countdown ring', () => {
  it('stays a finite number when the window is zero long', () => {
    const r = renderRN(
      <QuestionCard
        entry={entry({ permissionExpiry: { at: NOW - 1, windowMs: 0 } })}
        onAnswer={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const offset = Number(
      findHost(r.root, byTestId('question-countdown-fill')).props['strokeDashoffset'],
    );
    expect(Number.isFinite(offset)).toBe(true);
  });
});

describe('touch handling', () => {
  it('no text is selectable, so a drag on an option scrolls the list instead of grabbing text', () => {
    const r = renderRN(<QuestionCard entry={entry()} onAnswer={vi.fn()} onCancel={vi.fn()} />);
    const selectable = findAllHost(r.root, (n) => n.props?.selectable === true);
    expect(selectable).toHaveLength(0);
  });
});
