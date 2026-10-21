// meetingControl — what the Meeting button, the panel and the action cards do.
// Capture is acquired BEFORE the host is told to start, so a denied mic never
// leaves a live meeting that hears nothing.

import { SpeakerLog } from './speakerLog.js';
import {
  DEFAULT_MEETING_SETTINGS,
  type MeetingNotesOp,
  type MeetingSettings,
  type MeetingWriteup,
} from '@patch/wire';
import { getActiveWs } from '../api/ws.js';
import { getDesktopBridge, type PatchDesktopBridge } from './desktopBridge.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useMeetingStore } from '../stores/meetingStore.js';
import { useUiStore } from '../stores/uiStore.js';
import {
  startMeetingCapture,
  type MeetingCapture,
  type MeetingSources,
  type PcmFeed,
} from './meetingCapture.js';

let capture: MeetingCapture | null = null;

const SETTINGS_KEY = 'patch.meeting.liveness';

/** Named speeds for the live notes: [label, clip seconds, analysis seconds]. */
export const MEETING_SPEEDS: Record<string, MeetingSettings & { label: string }> = {
  fast: { label: 'Fast', clipSeconds: 3, analyseSeconds: 8 },
  normal: { label: 'Normal', ...DEFAULT_MEETING_SETTINGS },
  slow: { label: 'Slow (cheaper)', clipSeconds: 15, analyseSeconds: 30 },
};

/** The speeds as they stand now: Normal's analysis interval is the account setting. */
export function meetingSpeeds(): Record<string, MeetingSettings & { label: string }> {
  return {
    ...MEETING_SPEEDS,
    normal: {
      ...MEETING_SPEEDS['normal']!,
      analyseSeconds: usePreferencesStore.getState().preferences.meetingAnalyseSeconds,
    },
  };
}

export function getMeetingSpeed(): string {
  const v = localStorage.getItem(SETTINGS_KEY);
  return v !== null && v in MEETING_SPEEDS ? v : 'normal';
}

function speedSettings(speed: string): MeetingSettings {
  const { clipSeconds, analyseSeconds } = meetingSpeeds()[speed]!;
  return { clipSeconds, analyseSeconds };
}

/** Remember the choice and apply it to the running meeting. */
export function setMeetingSpeed(chatId: string, speed: string): void {
  if (!(speed in MEETING_SPEEDS)) throw new Error(`unknown meeting speed ${speed}`);
  localStorage.setItem(SETTINGS_KEY, speed);
  const settings = speedSettings(speed);
  capture?.setClipSeconds(settings.clipSeconds);
  ws().send({ type: 'meeting.control_request', chatId, action: 'tune', settings });
}

function ws(): NonNullable<ReturnType<typeof getActiveWs>> {
  const w = getActiveWs();
  if (!w) throw new Error('Not connected to the server');
  return w;
}

const speakerLog = new SpeakerLog();
let stopSpeakerWatch: (() => void) | null = null;

/** Seconds of 16 kHz mono PCM16 in a WAV clip (44-byte header). */
function wavSeconds(wavBytes: number): number {
  return Math.max(0, wavBytes - 44) / 2 / 16000;
}

/** Ask the shell who is lit up on the call. A failure is shown, and the meeting carries on with "Them". */
function watchSpeakers(bridge: PatchDesktopBridge): void {
  if (!bridge.startMeetingSpeakers || !bridge.onMeetingSpeakers) return;
  speakerLog.clear();
  const offSpeakers = bridge.onMeetingSpeakers(({ speaking }) =>
    speakerLog.record(speaking, Date.now()),
  );
  const offFailed = bridge.onMeetingSpeakersFailed?.(({ message }) =>
    useUiStore.getState().pushError(`Speaker names unavailable: ${message}`),
  );
  stopSpeakerWatch = () => {
    offSpeakers();
    offFailed?.();
    bridge.stopMeetingSpeakers?.();
  };
  bridge.startMeetingSpeakers();
}

/** Mic always; system audio too on the desktop app, through its native helper. */
export async function acquireSources(): Promise<MeetingSources> {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const bridge = getDesktopBridge();
  if (!bridge) return { mic };
  try {
    if (!bridge.startSystemAudio || !bridge.onSystemAudio) {
      throw new Error('this desktop app is too old to hear the call. Update Patch');
    }
    await bridge.startSystemAudio();
    watchSpeakers(bridge);
    return { mic, system: systemFeed(bridge) };
  } catch (err) {
    for (const t of mic.getTracks()) t.stop();
    throw new Error(`System audio unavailable: ${(err as Error).message}`);
  }
}

/** The shell's PCM bytes as a feed. Stopping it stops the helper. */
function systemFeed(bridge: PatchDesktopBridge): PcmFeed {
  return {
    subscribe(onPcm) {
      const offPcm = bridge.onSystemAudio!((bytes) => {
        // Whole samples only (the shell aligns them); copy so the view is 2-byte aligned.
        const copy = bytes.slice(0, bytes.byteLength - (bytes.byteLength % 2));
        onPcm(new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2));
      });
      const offFailed = bridge.onSystemAudioFailed?.(({ message }) => {
        stopCapture();
        useUiStore.getState().pushError(`System audio stopped: ${message}`);
      });
      return () => {
        offPcm();
        offFailed?.();
      };
    },
    stop() {
      bridge.stopSystemAudio?.();
    },
  };
}

async function beginCapture(chatId: string): Promise<void> {
  // 'new' is the new-chat screen's placeholder, not a chat: no host owns it, so
  // the server would drop every control frame and clip sent for it.
  if (chatId === 'new') throw new Error('Send a first message to create the chat, then start it');
  const sources = await acquireSources();
  try {
    capture = startMeetingCapture(
      sources,
      (source, audioBase64) => {
        try {
          // Who was lit up for most of the stretch this clip covers.
          const now = Date.now();
          const speakerName =
            source === 'system'
              ? speakerLog.dominant(now - wavSeconds(audioBase64.length * 0.75) * 1000, now)
              : undefined;
          ws().send({
            type: 'meeting.audio',
            chatId,
            source,
            audioBase64,
            ...(speakerName ? { speakerName } : {}),
          });
        } catch (err) {
          useUiStore.getState().pushError(`Meeting audio not sent: ${(err as Error).message}`);
        }
      },
      { clipSeconds: speedSettings(getMeetingSpeed()).clipSeconds },
    );
  } catch (err) {
    sources.mic?.getTracks().forEach((t) => t.stop());
    sources.system?.stop();
    throw err;
  }
  useMeetingStore.getState().setCapturing(chatId);
}

function report(what: string, err: unknown): void {
  useUiStore.getState().pushError(`${what}: ${(err as Error).message}`);
}

export async function startMeeting(chatId: string): Promise<void> {
  try {
    await beginCapture(chatId);
    ws().send({
      type: 'meeting.control_request',
      chatId,
      action: 'start',
      settings: speedSettings(getMeetingSpeed()),
    });
  } catch (err) {
    stopCapture();
    report('Could not start the meeting', err);
  }
}

/** Re-attach this surface's audio to a meeting the host still has running. */
export async function listenHere(chatId: string): Promise<void> {
  try {
    await beginCapture(chatId);
  } catch (err) {
    report('Could not listen', err);
  }
}

export function pauseMeeting(chatId: string): void {
  capture?.setPaused(true);
  ws().send({ type: 'meeting.control_request', chatId, action: 'pause' });
}

export function resumeMeeting(chatId: string): void {
  capture?.setPaused(false);
  ws().send({ type: 'meeting.control_request', chatId, action: 'resume' });
}

/** Reopens a meeting that has ended: starts listening again here, then the host goes live. */
export async function resumeEndedMeeting(chatId: string): Promise<void> {
  try {
    await beginCapture(chatId);
    ws().send({ type: 'meeting.control_request', chatId, action: 'resume' });
  } catch (err) {
    stopCapture();
    report('Could not resume the meeting', err);
  }
}

/** Flushes the last audio first, so it reaches the host ahead of `end`. */
export function endMeeting(chatId: string): void {
  stopCapture();
  ws().send({ type: 'meeting.control_request', chatId, action: 'end' });
}

export function decideAction(
  chatId: string,
  actionId: string,
  decision: 'do' | 'chat' | 'dismiss',
): void {
  ws().send({ type: 'meeting.action_request', chatId, actionId, decision });
}

/** Hands someone else's action to a speaker, or `Everyone`. */
export function setActionOwner(chatId: string, actionId: string, owner: string): void {
  ws().send({ type: 'meeting.action_request', chatId, actionId, owner });
}

/** The tray checkbox: agent actions start by themselves when on. */
export function setAgentRunsActions(chatId: string, agentRuns: boolean): void {
  ws().send({ type: 'meeting.action_request', chatId, agentRuns });
}

/** The "Research as we go" checkbox. */
export function setMeetingResearch(chatId: string, on: boolean): void {
  ws().send({ type: 'meeting.research_request', chatId, on });
}

/** An edit to the points panel; the host stores it as fixed input and answers with `meeting.state`. */
export function editMeetingNotes(chatId: string, edit: MeetingNotesOp): void {
  ws().send({ type: 'meeting.notes_request', chatId, edit });
}

/** The My notes text; the host stores it with the meeting and answers with `meeting.state`. */
export function saveMyNotes(chatId: string, text: string): void {
  ws().send({ type: 'meeting.my_notes_request', chatId, text });
}

/** The edited final write-up; the host stores it and answers with `meeting.state`. */
export function saveWriteup(chatId: string, writeup: MeetingWriteup): void {
  ws().send({ type: 'meeting.writeup_request', chatId, writeup });
}

/** Write the final write-up again from the transcript and My notes. */
export function regenerateWriteup(chatId: string): void {
  ws().send({ type: 'meeting.writeup_request', chatId, regenerate: true });
}

export function requestMeeting(chatId: string): void {
  getActiveWs()?.send({ type: 'meeting.get_request', chatId });
}

function stopCapture(): void {
  capture?.stop();
  stopSpeakerWatch?.();
  stopSpeakerWatch = null;
  capture = null;
  useMeetingStore.getState().setCapturing(null);
}

/** Test seam. */
export function __resetMeetingControlForTests(): void {
  capture = null;
}
