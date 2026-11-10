import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MeetingDetectionBanner } from '../components/MeetingDetectionBanner.js';

type Cb = (e: { off: boolean; message: string | null }) => void;

function install(initial: { off: boolean; message: string | null }): { push: Cb } {
  let cb: Cb = () => {};
  (window as unknown as { patch?: unknown }).patch = {
    getMeetingDetection: () => Promise.resolve(initial),
    onMeetingDetection: (c: Cb) => {
      cb = c;
      return () => {};
    },
  };
  return { push: (e) => cb(e) };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { patch?: unknown }).patch;
});

describe('MeetingDetectionBanner', () => {
  it('renders nothing in a browser', () => {
    render(<MeetingDetectionBanner />);
    expect(screen.queryByTestId('meeting-detection-banner')).toBeNull();
  });

  it('stays hidden while detection is running', async () => {
    install({ off: false, message: null });
    render(<MeetingDetectionBanner />);
    await act(async () => {});
    expect(screen.queryByTestId('meeting-detection-banner')).toBeNull();
  });

  it('shows the reason when off and clears on recovery', async () => {
    const { push } = install({ off: true, message: 'mic-watch exited (1)' });
    render(<MeetingDetectionBanner />);
    expect(await screen.findByTestId('meeting-detection-banner')).toHaveTextContent(
      'mic-watch exited (1)',
    );
    act(() => push({ off: false, message: null }));
    expect(screen.queryByTestId('meeting-detection-banner')).toBeNull();
  });
});
