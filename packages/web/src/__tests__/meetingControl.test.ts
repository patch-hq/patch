import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock('../api/ws.js', () => ({ getActiveWs: () => ({ send }) }));

import { startMeeting, listenHere, meetingSpeeds, setMeetingSpeed } from '../lib/meetingControl.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useMeetingStore } from '../stores/meetingStore.js';

// A meeting belongs to a real chat. The new-chat screen's placeholder id 'new'
// has no host, so the server can only drop every frame sent for it.
describe('meetingControl on the new-chat placeholder', () => {
  const getUserMedia = vi.fn();
  beforeEach(() => {
    send.mockReset();
    getUserMedia.mockReset();
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });
    useMeetingStore.getState().reset();
  });

  it('startMeeting refuses with a visible error and opens no mic or capture', async () => {
    const pushError = vi.spyOn(useUiStore.getState(), 'pushError');
    await startMeeting('new');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(useMeetingStore.getState().capturingChatId).toBeNull();
    expect(pushError).toHaveBeenCalledWith(
      expect.stringMatching(/Could not start the meeting.*chat/),
    );
  });

  it('listenHere refuses the same way', async () => {
    await listenHere('new');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('meeting speeds', () => {
  it('Normal takes its analysis interval from the account setting; Fast and Slow stay put', () => {
    const prefs = usePreferencesStore.getState().preferences;
    usePreferencesStore.setState({ preferences: { ...prefs, meetingAnalyseSeconds: 45 } });
    expect(meetingSpeeds()['normal']!.analyseSeconds).toBe(45);
    expect(meetingSpeeds()['fast']!.analyseSeconds).toBe(8);
    send.mockReset();
    setMeetingSpeed('c1', 'normal');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tune', settings: { clipSeconds: 6, analyseSeconds: 45 } }),
    );
    usePreferencesStore.setState({ preferences: prefs });
  });
});
