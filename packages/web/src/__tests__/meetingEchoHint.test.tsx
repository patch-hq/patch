// Meeting mode: when the host saw the mic repeat the call, the bar suggests headphones.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { MeetingState } from '@patch/wire';
import { MeetingBar } from '../components/MeetingPanel.js';

const meeting = (over: Partial<MeetingState> = {}): MeetingState => ({
  status: 'live',
  startedAt: 0,
  elapsedBaseMs: 0,
  resumedAt: 0,
  now: null,
  summary: null,
  topics: [],
  actions: [],
  transcript: [],
  error: null,
  ...over,
});

describe('MeetingBar echo hint', () => {
  afterEach(cleanup);

  it('shows the headphones hint only once echo is detected', () => {
    const { rerender } = render(<MeetingBar chatId="c1" meeting={meeting()} />);
    expect(screen.queryByTestId('meeting-echo-hint')).toBeNull();
    rerender(<MeetingBar chatId="c1" meeting={meeting({ echoDetected: true })} />);
    expect(screen.getByTestId('meeting-echo-hint').textContent).toContain('headphones');
  });
});
