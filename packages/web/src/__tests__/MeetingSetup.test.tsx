import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const startMeeting = vi.fn();
vi.mock('../lib/meetingControl.js', () => ({
  startMeeting: (...a: unknown[]) => startMeeting(...a),
}));

import { MeetingSetup } from '../components/MeetingSetup.js';
import { useMeetingSetup } from '../lib/meetingSetup.js';

const win = window as unknown as { patch?: unknown };

beforeEach(() => {
  startMeeting.mockReset();
  localStorage.clear();
  win.patch = {
    requestMeetingPermission: vi.fn(async () => ({
      microphone: true,
      callAudio: true,
      accessibility: true,
    })),
  };
});

describe('<MeetingSetup>', () => {
  it('renders nothing while closed', () => {
    useMeetingSetup.setState({ mode: null, chatId: null, perms: null });
    const { container } = render(<MeetingSetup chatId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('first-run card: lists the three permissions, Allow on the missing ones, dismissible', () => {
    useMeetingSetup.setState({
      mode: 'first-run',
      chatId: null,
      perms: { microphone: true, callAudio: false, accessibility: false },
    });
    render(<MeetingSetup chatId="c1" />);
    expect(screen.getByTestId('meeting-perm-microphone')).toHaveTextContent('Allowed');
    expect(screen.getByTestId('meeting-allow-callAudio')).toBeInTheDocument();
    expect(screen.getByTestId('meeting-allow-accessibility')).toBeInTheDocument();
    expect(screen.queryByTestId('meeting-start')).toBeNull();
    fireEvent.click(screen.getByTestId('meeting-setup-dismiss'));
    expect(localStorage.getItem('patch.meeting.setupDismissed')).toBe('1');
    expect(useMeetingSetup.getState().mode).toBeNull();
  });

  it('start popover: Start is disabled until all are allowed; Start without names needs mic + call audio', () => {
    useMeetingSetup.setState({
      mode: 'start',
      chatId: 'c1',
      perms: { microphone: true, callAudio: true, accessibility: false },
    });
    render(<MeetingSetup chatId="c1" />);
    expect(screen.getByTestId('meeting-start')).toBeDisabled();
    fireEvent.click(screen.getByTestId('meeting-start-without-names'));
    expect(startMeeting).toHaveBeenCalledWith('c1', false);
  });

  it('start popover: Allow turns Start on, and Start begins the meeting', async () => {
    useMeetingSetup.setState({
      mode: 'start',
      chatId: 'c1',
      perms: { microphone: true, callAudio: true, accessibility: false },
    });
    render(<MeetingSetup chatId="c1" />);
    fireEvent.click(screen.getByTestId('meeting-allow-accessibility'));
    await waitFor(() => expect(screen.getByTestId('meeting-start')).toBeEnabled());
    fireEvent.click(screen.getByTestId('meeting-start'));
    expect(startMeeting).toHaveBeenCalledWith('c1');
  });

  it('start popover belongs to the chat Start was pressed in', () => {
    useMeetingSetup.setState({
      mode: 'start',
      chatId: 'c1',
      perms: { microphone: true, callAudio: true, accessibility: false },
    });
    const { container } = render(<MeetingSetup chatId="c2" />);
    expect(container).toBeEmptyDOMElement();
  });
});
