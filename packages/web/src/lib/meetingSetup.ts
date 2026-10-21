// meetingSetup — asks for Meeting mode's macOS permissions (Microphone, Call
// audio, Accessibility) before a meeting, not as it starts. Two steps: a
// dismissible "Meetings" card on first run, and a check when Start is pressed
// that shows only what is still missing. A plain browser has no such
// permissions to manage, so it starts straight away.

import { create } from 'zustand';
import {
  getDesktopBridge,
  type MeetingPermissionKind,
  type MeetingPermissionState,
} from './desktopBridge.js';
import { useUiStore } from '../stores/uiStore.js';
import { startMeeting } from './meetingControl.js';

const DISMISSED_KEY = 'patch.meeting.setupDismissed';

interface MeetingSetupState {
  /** Which popover is open: the first-run card, or the one Start opens. */
  mode: 'first-run' | 'start' | null;
  /** The chat Start was pressed in; the first-run card belongs to no chat. */
  chatId: string | null;
  perms: MeetingPermissionState | null;
}

export const useMeetingSetup = create<MeetingSetupState>(() => ({
  mode: null,
  chatId: null,
  perms: null,
}));

export const isAllGranted = (p: MeetingPermissionState): boolean =>
  p.microphone && p.callAudio && p.accessibility;

async function read(): Promise<MeetingPermissionState | null> {
  const bridge = getDesktopBridge();
  if (!bridge?.getMeetingPermissions) return null;
  const perms = await bridge.getMeetingPermissions();
  useMeetingSetup.setState({ perms });
  return perms;
}

/** On launch: offer the setup card once, if anything is missing and it was not dismissed. */
export async function offerFirstRunSetup(): Promise<void> {
  if (localStorage.getItem(DISMISSED_KEY)) return;
  try {
    const perms = await read();
    if (perms && !isAllGranted(perms))
      useMeetingSetup.setState({ mode: 'first-run', chatId: null });
  } catch (err) {
    useUiStore.getState().pushError(`Meeting permissions unavailable: ${(err as Error).message}`);
  }
}

/** The Meeting button / call notification: start if everything is allowed, else show what is missing. */
export async function requestMeetingStart(chatId: string): Promise<void> {
  let perms: MeetingPermissionState | null;
  try {
    perms = await read();
  } catch (err) {
    useUiStore.getState().pushError(`Meeting permissions unavailable: ${(err as Error).message}`);
    return;
  }
  if (!perms || isAllGranted(perms)) {
    closeMeetingSetup();
    return startMeeting(chatId);
  }
  useMeetingSetup.setState({ mode: 'start', chatId });
}

export async function allowMeetingPermission(kind: MeetingPermissionKind): Promise<void> {
  try {
    const perms = await getDesktopBridge()!.requestMeetingPermission!(kind);
    useMeetingSetup.setState({ perms });
  } catch (err) {
    useUiStore.getState().pushError(`Could not allow ${kind}: ${(err as Error).message}`);
  }
}

export function closeMeetingSetup(): void {
  useMeetingSetup.setState({ mode: null, chatId: null });
}

/** The card's ✕: not asked again on launch. */
export function dismissFirstRunSetup(): void {
  localStorage.setItem(DISMISSED_KEY, '1');
  closeMeetingSetup();
}

export function startWithoutNames(chatId: string): void {
  closeMeetingSetup();
  void startMeeting(chatId, false);
}
