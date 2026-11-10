// meetingSetup — meeting mode's macOS permissions, asked for ahead of time.
// Once, a gentle popover on the Meeting button lists what a meeting needs; and
// pressing Meeting with something still missing shows the same list with a
// Start button, instead of a meeting that fails at its first second. Only the
// desktop app on macOS has anything to set up; elsewhere Meeting just starts.

import { create } from 'zustand';
import {
  getDesktopBridge,
  type MeetingPermissionKind,
  type MeetingPermissions,
} from './desktopBridge.js';
import { startMeeting } from './meetingControl.js';
import { useUiStore } from '../stores/uiStore.js';

const SEEN_KEY = 'patch.meetingSetupSeen';
const DECLINED_KEY = 'patch.meetingNamesDeclined';

export type MeetingSetupMode = 'intro' | 'start';

interface MeetingSetupState {
  /** Which chat's Meeting button the popover sits on, and why it is open. */
  open: { chatId: string; mode: MeetingSetupMode } | null;
  permissions: MeetingPermissions | null;
  /** The permission being asked for right now. */
  asking: MeetingPermissionKind | null;
  /** Tom chose to start meetings without speaker names; stop asking for Accessibility. */
  namesDeclined: boolean;
  close(): void;
}

export const useMeetingSetup = create<MeetingSetupState>((set) => ({
  open: null,
  permissions: null,
  asking: null,
  namesDeclined: localStorage.getItem(DECLINED_KEY) === '1',
  close: () => {
    localStorage.setItem(SEEN_KEY, '1');
    set({ open: null });
  },
}));

/** Remember (or forget) that Tom does not want to be asked about speaker names. */
export function setNamesDeclined(declined: boolean): void {
  if (declined) localStorage.setItem(DECLINED_KEY, '1');
  else localStorage.removeItem(DECLINED_KEY);
  useMeetingSetup.setState({ namesDeclined: declined });
}

/**
 * Settings toggle, turned on: forget the decline and ask for Accessibility
 * again, the way the first prompt does. Left unanswered it is asked at the
 * next meeting.
 */
export async function reenableSpeakerNames(): Promise<void> {
  setNamesDeclined(false);
  const p = await readPermissions();
  if (p && p.accessibility !== 'granted') await allowPermission('accessibility');
}

/** What still stands between Tom and a meeting with names. */
export function missing(p: MeetingPermissions): MeetingPermissionKind[] {
  return (Object.keys(p) as MeetingPermissionKind[]).filter((k) => p[k] !== 'granted');
}

/** Reads where they stand now, e.g. when Tom comes back from System Settings. */
export async function readPermissions(): Promise<MeetingPermissions | null> {
  const bridge = getDesktopBridge();
  if (!bridge?.getMeetingPermissions) return null;
  const p = await bridge.getMeetingPermissions();
  useMeetingSetup.setState({ permissions: p });
  return p;
}

/** The first-run popover: once ever, and only when something is missing. */
export async function maybeIntroduceMeetings(chatId: string): Promise<void> {
  if (localStorage.getItem(SEEN_KEY) || useMeetingSetup.getState().open) return;
  const p = await readPermissions();
  if (!p || missing(p).length === 0) return;
  if (useMeetingSetup.getState().open) return;
  useMeetingSetup.setState({ open: { chatId, mode: 'intro' } });
}

/** The Meeting button: starts at once when everything is allowed, else shows what is missing. */
export async function beginMeeting(chatId: string): Promise<void> {
  let p: MeetingPermissions | null;
  try {
    p = await readPermissions();
  } catch (err) {
    useUiStore
      .getState()
      .pushError(`Could not check meeting permissions: ${(err as Error).message}`);
    return;
  }
  if (!p || missing(p).length === 0) {
    useMeetingSetup.setState({ open: null });
    return startMeeting(chatId);
  }
  const gaps = missing(p);
  if (
    useMeetingSetup.getState().namesDeclined &&
    gaps.length === 1 &&
    gaps[0] === 'accessibility'
  ) {
    useMeetingSetup.setState({ open: null });
    return startMeeting(chatId, { names: false });
  }
  useMeetingSetup.setState({ open: { chatId, mode: 'start' } });
}

/** One Allow button. A refusal is shown, and the list says where it stands. */
export async function allowPermission(kind: MeetingPermissionKind): Promise<void> {
  const bridge = getDesktopBridge();
  if (!bridge?.requestMeetingPermission) return;
  useMeetingSetup.setState({ asking: kind });
  try {
    await bridge.requestMeetingPermission(kind);
  } catch (err) {
    useUiStore.getState().pushError(`Not allowed: ${(err as Error).message}`);
  } finally {
    useMeetingSetup.setState({ asking: null });
    const p = await readPermissions();
    if (kind === 'accessibility' && p?.accessibility === 'granted') setNamesDeclined(false);
  }
}

/** Start from the popover: with names, or without when Accessibility is the only gap. */
export function startFromSetup(chatId: string, names: boolean): Promise<void> {
  useMeetingSetup.getState().close();
  if (!names) setNamesDeclined(true);
  return startMeeting(chatId, { names });
}

/** Test seam. */
export function __resetMeetingSetupForTests(): void {
  localStorage.removeItem(DECLINED_KEY);
  useMeetingSetup.setState({ open: null, permissions: null, asking: null, namesDeclined: false });
}
