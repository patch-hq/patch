// spec/14 § Actions tray — the "agent runs its own actions" checkbox is for a
// meeting in progress; once it has ended there is nothing left to run, so the
// checkbox is not shown at all.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MeetingActions } from '../components/MeetingPanel.js';
import type { MeetingState } from '@patch/wire';

function meeting(status: 'live' | 'ended'): MeetingState {
  return {
    status,
    transcript: [],
    actions: [{ id: 'a1', kind: 'mine', title: 'Top up credit', at: 1000, status: 'pending' }],
  } as unknown as MeetingState;
}

const show = (status: 'live' | 'ended') =>
  render(
    <MemoryRouter>
      <MeetingActions chatId="c1" meeting={meeting(status)} />
    </MemoryRouter>,
  );

describe('MeetingActions agent-runs checkbox', () => {
  afterEach(cleanup);

  it('is shown while the meeting is live', () => {
    show('live');
    expect(screen.getByTestId('meeting-agent-runs')).toBeTruthy();
  });

  it('is gone once the meeting has ended, while the tray itself stays', () => {
    show('ended');
    expect(screen.getByTestId('meeting-actions')).toBeTruthy();
    expect(screen.queryByTestId('meeting-agent-runs')).toBeNull();
  });
});
