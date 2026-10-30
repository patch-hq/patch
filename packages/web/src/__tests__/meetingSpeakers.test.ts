import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock('../api/ws.js', () => ({ getActiveWs: () => ({ send }) }));

let onClip: (source: 'mic' | 'system', wav: string) => void = () => undefined;
vi.mock('../lib/meetingCapture.js', () => ({
  startMeetingCapture: (_s: unknown, cb: typeof onClip) => {
    onClip = cb;
    return { setPaused: vi.fn(), setClipSeconds: vi.fn(), stop: vi.fn() };
  },
}));

import { startMeeting, endMeeting, NO_PARTICIPANTS_AFTER_MS } from '../lib/meetingControl.js';
import { useUiStore } from '../stores/uiStore.js';
import { useMeetingStore } from '../stores/meetingStore.js';

// 1 s of 16 kHz PCM16 + 44-byte header, base64.
const CLIP = btoa('a'.repeat(44 + 32000));

describe('meeting speaker names (desktop shell)', () => {
  let speakers: (e: { participants: string[]; speaking: string[] }) => void;
  let failed: (e: { message: string }) => void;
  const bridge = {
    startSystemAudio: vi.fn(async () => undefined),
    stopSystemAudio: vi.fn(),
    onSystemAudio: vi.fn(() => () => undefined),
    startMeetingSpeakers: vi.fn(),
    stopMeetingSpeakers: vi.fn(),
    onMeetingSpeakers: vi.fn((cb: typeof speakers) => {
      speakers = cb;
      return () => undefined;
    }),
    onMeetingSpeakersFailed: vi.fn((cb: typeof failed) => {
      failed = cb;
      return () => undefined;
    }),
  };

  beforeEach(() => {
    send.mockReset();
    vi.useRealTimers();
    useMeetingStore.getState().reset();
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      value: { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [] }) },
      configurable: true,
    });
    (window as unknown as { patch: unknown }).patch = bridge;
  });

  it('stamps a system clip with whoever was lit up, never a mic clip', async () => {
    await startMeeting('c1');
    expect(bridge.startMeetingSpeakers).toHaveBeenCalled();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(10_000);
    speakers({ participants: ['Priya'], speaking: ['Priya'] });
    now.mockReturnValue(11_000);
    onClip('system', CLIP);
    onClip('mic', CLIP);
    const audio = send.mock.calls.map((c) => c[0]).filter((e) => e.type === 'meeting.audio');
    expect(audio[0]).toMatchObject({ source: 'system', speakerName: 'Priya' });
    expect(audio[1].speakerName).toBeUndefined();
    now.mockRestore();
  });

  it('sends no name when nobody is lit up', async () => {
    await startMeeting('c1');
    speakers({ participants: ['Priya'], speaking: [] });
    onClip('system', CLIP);
    const e = send.mock.calls.map((c) => c[0]).find((x) => x.type === 'meeting.audio');
    expect(e.speakerName).toBeUndefined();
  });

  it('shows a speaker-reading failure and stops the watcher when the meeting ends', async () => {
    const pushError = vi.spyOn(useUiStore.getState(), 'pushError');
    await startMeeting('c1');
    failed({ message: 'Accessibility is not allowed' });
    expect(pushError).toHaveBeenCalledWith(
      expect.stringMatching(/Speaker names unavailable.*Accessibility/),
    );
    endMeeting('c1');
    expect(bridge.stopMeetingSpeakers).toHaveBeenCalled();
  });

  it('says so when the call app shows no participants, and stays quiet when it does', async () => {
    vi.useFakeTimers();
    const pushError = vi.spyOn(useUiStore.getState(), 'pushError');
    pushError.mockClear();
    await startMeeting('c1');
    vi.advanceTimersByTime(NO_PARTICIPANTS_AFTER_MS);
    expect(pushError).toHaveBeenCalledWith(expect.stringMatching(/no call participants found/));
    endMeeting('c1');

    pushError.mockClear();
    await startMeeting('c1');
    speakers({ participants: ['Priya'], speaking: [] });
    vi.advanceTimersByTime(NO_PARTICIPANTS_AFTER_MS);
    expect(pushError).not.toHaveBeenCalled();
    endMeeting('c1');
  });
});
