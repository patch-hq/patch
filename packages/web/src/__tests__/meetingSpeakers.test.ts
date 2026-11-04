import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock('../api/ws.js', () => ({ getActiveWs: () => ({ send }) }));

vi.mock('../lib/meetingCapture.js', () => ({
  startMeetingCapture: () => ({ setPaused: vi.fn(), stop: vi.fn() }),
}));

import { startMeeting, endMeeting, NO_PARTICIPANTS_AFTER_MS } from '../lib/meetingControl.js';
import { useUiStore } from '../stores/uiStore.js';
import { useMeetingStore } from '../stores/meetingStore.js';

type Text = {
  source: 'mic' | 'system';
  text: string;
  startedAt: number;
  endedAt: number;
  final: boolean;
};
let heard: (t: Text) => void = () => undefined;
const said = (source: Text['source'], startedAt: number, endedAt: number): void =>
  heard({ source, text: 'something', startedAt, endedAt, final: true });

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
    startMeetingTranscription: vi.fn(async () => undefined),
    pushMeetingAudio: vi.fn(),
    flushMeetingTranscription: vi.fn(async () => undefined),
    stopMeetingTranscription: vi.fn(async () => undefined),
    onMeetingText: vi.fn((cb: (t: Text) => void) => {
      heard = cb;
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

  it('stamps a system line with whoever was lit up while it was said, never a mic line', async () => {
    await startMeeting('c1');
    expect(bridge.startMeetingSpeakers).toHaveBeenCalled();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(10_000);
    speakers({ participants: ['Priya'], speaking: ['Priya'] });
    now.mockReturnValue(11_000);
    said('system', 10_000, 11_000);
    said('mic', 10_000, 11_000);
    const lines = send.mock.calls.map((c) => c[0]).filter((e) => e.type === 'meeting.lines');
    expect(lines[0]).toMatchObject({
      source: 'system',
      lines: [{ text: 'something', spokenAt: 10_000, speakerName: 'Priya' }],
    });
    expect(lines[1].lines[0].speakerName).toBeUndefined();
    now.mockRestore();
  });

  it('sends no name when nobody is lit up', async () => {
    await startMeeting('c1');
    speakers({ participants: ['Priya'], speaking: [] });
    said('system', Date.now() - 1000, Date.now());
    const e = send.mock.calls.map((c) => c[0]).find((x) => x.type === 'meeting.lines');
    expect(e.lines[0].speakerName).toBeUndefined();
  });

  it('shows what is still being said, and sends only finished lines', async () => {
    await startMeeting('c1');
    heard({ source: 'system', text: 'so the', startedAt: 1, endedAt: 2, final: false });
    expect(useMeetingStore.getState().hearing.system).toBe('so the');
    expect(send.mock.calls.some((c) => c[0].type === 'meeting.lines')).toBe(false);
    heard({ source: 'system', text: 'so the plan', startedAt: 1, endedAt: 3, final: true });
    expect(useMeetingStore.getState().hearing.system).toBeUndefined();
  });

  it('ends only after the last words are transcribed and sent', async () => {
    await startMeeting('c1');
    let finish!: () => void;
    bridge.stopMeetingTranscription.mockImplementationOnce(
      () =>
        new Promise<undefined>((r) => {
          finish = () => {
            said('mic', 1, 2);
            r(undefined);
          };
        }),
    );
    const ending = endMeeting('c1');
    await Promise.resolve();
    expect(send.mock.calls.some((c) => c[0].action === 'end')).toBe(false);
    finish();
    await ending;
    const types = send.mock.calls.map((c) => c[0].action ?? c[0].type);
    expect(types.slice(-2)).toEqual(['meeting.lines', 'end']);
  });

  it('shows a speaker-reading failure and stops the watcher when the meeting ends', async () => {
    const pushError = vi.spyOn(useUiStore.getState(), 'pushError');
    await startMeeting('c1');
    failed({ message: 'Accessibility is not allowed' });
    expect(pushError).toHaveBeenCalledWith(
      expect.stringMatching(/Speaker names unavailable.*Accessibility/),
    );
    await endMeeting('c1');
    expect(bridge.stopMeetingSpeakers).toHaveBeenCalled();
  });

  it('says so when the call app shows no participants, and stays quiet when it does', async () => {
    vi.useFakeTimers();
    const pushError = vi.spyOn(useUiStore.getState(), 'pushError');
    pushError.mockClear();
    await startMeeting('c1');
    vi.advanceTimersByTime(NO_PARTICIPANTS_AFTER_MS);
    expect(pushError).toHaveBeenCalledWith(expect.stringMatching(/no call participants found/));
    await endMeeting('c1');

    pushError.mockClear();
    await startMeeting('c1');
    speakers({ participants: ['Priya'], speaking: [] });
    vi.advanceTimersByTime(NO_PARTICIPANTS_AFTER_MS);
    expect(pushError).not.toHaveBeenCalled();
    await endMeeting('c1');
  });
});
