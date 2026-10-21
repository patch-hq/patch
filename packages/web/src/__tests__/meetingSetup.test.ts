import { beforeEach, describe, expect, it, vi } from 'vitest';

const startMeeting = vi.fn();
vi.mock('../lib/meetingControl.js', () => ({
  startMeeting: (...a: unknown[]) => startMeeting(...a),
}));

import {
  allowMeetingPermission,
  dismissFirstRunSetup,
  offerFirstRunSetup,
  requestMeetingStart,
  startWithoutNames,
  useMeetingSetup,
} from '../lib/meetingSetup.js';

const ALL = { microphone: true, callAudio: true, accessibility: true };
const win = window as unknown as { patch?: unknown };

function bridge(perms: Record<string, boolean>) {
  const state = { ...perms };
  win.patch = {
    getMeetingPermissions: vi.fn(async () => ({ ...state })),
    requestMeetingPermission: vi.fn(async (kind: string) => {
      state[kind] = true;
      return { ...state };
    }),
  };
}

beforeEach(() => {
  startMeeting.mockReset();
  localStorage.clear();
  useMeetingSetup.setState({ mode: null, chatId: null, perms: null });
  delete win.patch;
});

describe('meeting permission setup', () => {
  it('first run: offers the card once when something is missing', async () => {
    bridge({ ...ALL, accessibility: false });
    await offerFirstRunSetup();
    expect(useMeetingSetup.getState().mode).toBe('first-run');
  });

  it('first run: stays closed when everything is allowed, or after Not now', async () => {
    bridge(ALL);
    await offerFirstRunSetup();
    expect(useMeetingSetup.getState().mode).toBeNull();
    bridge({ ...ALL, callAudio: false });
    await offerFirstRunSetup();
    dismissFirstRunSetup();
    await offerFirstRunSetup();
    expect(useMeetingSetup.getState().mode).toBeNull();
  });

  it('Start with everything allowed starts at once', async () => {
    bridge(ALL);
    await requestMeetingStart('c1');
    expect(startMeeting).toHaveBeenCalledWith('c1');
    expect(useMeetingSetup.getState().mode).toBeNull();
  });

  it('Start with something missing opens the popover and does not start', async () => {
    bridge({ ...ALL, accessibility: false });
    await requestMeetingStart('c1');
    expect(startMeeting).not.toHaveBeenCalled();
    expect(useMeetingSetup.getState()).toMatchObject({ mode: 'start', chatId: 'c1' });
  });

  it('Allow asks the shell and updates what is missing', async () => {
    bridge({ ...ALL, accessibility: false });
    await requestMeetingStart('c1');
    await allowMeetingPermission('accessibility');
    expect(useMeetingSetup.getState().perms).toEqual(ALL);
  });

  it('Start without names starts with names off', () => {
    startWithoutNames('c1');
    expect(startMeeting).toHaveBeenCalledWith('c1', false);
  });

  it('a plain browser has no permissions to manage: starts straight away', async () => {
    await requestMeetingStart('c1');
    expect(startMeeting).toHaveBeenCalledWith('c1');
  });
});
