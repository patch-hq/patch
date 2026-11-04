// meetingControl — what the Meeting button, the panel and the action cards do.
// Capture is acquired BEFORE the host is told to start, so a denied mic never
// leaves a live meeting that hears nothing.
//
// The desktop app transcribes on this device (spec/07 § Meeting transcription):
// audio goes to the shell, text comes back, and only text is sent to the host
// as `meeting.lines`. A browser with no desktop app cannot listen.

import { SpeakerLog } from './speakerLog.js';
import {
  DEFAULT_MEETING_SETTINGS,
  meetingElapsedMs,
  type MeetingAction,
  type MeetingState,
  type MeetingNotesOp,
  type MeetingSettings,
  type MeetingWriteup,
} from '@patch/wire';
import { getActiveWs } from '../api/ws.js';
import { addMeetingNote, editMeetingNote } from './meetingNotes.js';
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
/** Undoes the transcription listeners for the capture in progress. */
let stopListening: (() => void) | null = null;

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
  ws().send({ type: 'meeting.control_request', chatId, action: 'tune', settings });
}

function ws(): NonNullable<ReturnType<typeof getActiveWs>> {
  const w = getActiveWs();
  if (!w) throw new Error('Not connected to the server');
  return w;
}

const speakerLog = new SpeakerLog();
let stopSpeakerWatch: (() => void) | null = null;

/** How long the call app may go without showing a single participant before the meeting says so. */
export const NO_PARTICIPANTS_AFTER_MS = 90_000;

/** Ask the shell who is lit up on the call. A failure is shown, and the meeting carries on with "Them". */
function watchSpeakers(bridge: PatchDesktopBridge): void {
  if (!bridge.startMeetingSpeakers || !bridge.onMeetingSpeakers) return;
  speakerLog.clear();
  let sawParticipants = false;
  const noParticipants = setTimeout(() => {
    if (sawParticipants) return;
    useUiStore
      .getState()
      .pushError(
        'Speaker names unavailable: no call participants found in Teams, Zoom or a browser. Open the call window and check Patch is allowed in Privacy & Security > Accessibility. Lines stay "Them".',
      );
  }, NO_PARTICIPANTS_AFTER_MS);
  const offSpeakers = bridge.onMeetingSpeakers(({ participants, speaking }) => {
    if (participants.length > 0) sawParticipants = true;
    speakerLog.record(speaking, Date.now());
  });
  const offFailed = bridge.onMeetingSpeakersFailed?.(({ message }) =>
    useUiStore.getState().pushError(`Speaker names unavailable: ${message}`),
  );
  stopSpeakerWatch = () => {
    clearTimeout(noParticipants);
    offSpeakers();
    offFailed?.();
    bridge.stopMeetingSpeakers?.();
  };
  bridge.startMeetingSpeakers();
}

/**
 * Mic always; system audio too on the desktop app, through its native helper.
 * `names: false` is Tom starting without Accessibility: no speaker watch, so no
 * error about it either.
 */
export async function acquireSources(opts: { names?: boolean } = {}): Promise<MeetingSources> {
  const bridge = deviceTranscriber();
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    if (!bridge.startSystemAudio || !bridge.onSystemAudio) {
      throw new Error('this desktop app is too old to hear the call. Update Patch');
    }
    await bridge.startSystemAudio();
    if (opts.names !== false) watchSpeakers(bridge);
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
        void stopCapture();
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

/** The shell, when it can transcribe here. Meetings never send audio off the device. */
function deviceTranscriber(): PatchDesktopBridge &
  Required<
    Pick<
      PatchDesktopBridge,
      | 'startMeetingTranscription'
      | 'pushMeetingAudio'
      | 'flushMeetingTranscription'
      | 'stopMeetingTranscription'
      | 'onMeetingText'
    >
  > {
  const bridge = getDesktopBridge();
  if (!bridge) {
    throw new Error(
      'Meetings are transcribed on your computer, so they listen from the Patch desktop app',
    );
  }
  const {
    startMeetingTranscription,
    pushMeetingAudio,
    flushMeetingTranscription,
    stopMeetingTranscription,
    onMeetingText,
  } = bridge;
  if (
    !startMeetingTranscription ||
    !pushMeetingAudio ||
    !flushMeetingTranscription ||
    !stopMeetingTranscription ||
    !onMeetingText
  ) {
    throw new Error('This desktop app is too old to transcribe meetings. Update Patch');
  }
  return {
    ...bridge,
    startMeetingTranscription: startMeetingTranscription.bind(bridge),
    pushMeetingAudio: pushMeetingAudio.bind(bridge),
    flushMeetingTranscription: flushMeetingTranscription.bind(bridge),
    stopMeetingTranscription: stopMeetingTranscription.bind(bridge),
    onMeetingText: onMeetingText.bind(bridge),
  };
}

/** Sends what this device transcribed to the host, and shows what it is still hearing. */
function listen(chatId: string, bridge: ReturnType<typeof deviceTranscriber>): () => void {
  const store = useMeetingStore.getState();
  const offText = bridge.onMeetingText((t) => {
    if (!t.final) {
      store.setHearing(t.source, t.text);
      return;
    }
    store.setHearing(t.source, null);
    // Who was lit up for most of the utterance.
    const speakerName =
      t.source === 'system' ? speakerLog.dominant(t.startedAt, t.endedAt) : undefined;
    try {
      ws().send({
        type: 'meeting.lines',
        chatId,
        source: t.source,
        lines: [
          {
            text: t.text,
            spokenAt: Math.round(t.startedAt),
            ...(speakerName ? { speakerName } : {}),
          },
        ],
      });
    } catch (err) {
      report('Meeting line not sent', err);
    }
  });
  const offError = bridge.onMeetingTranscribeError?.(({ message }) =>
    report('Transcription failed', new Error(message)),
  );
  let told = false;
  const offProgress = bridge.onMeetingTranscribeProgress?.((p) => {
    if (!told) {
      told = true;
      useUiStore
        .getState()
        .pushNotice(
          'Downloading the speech model for meetings (about 670 MB, once). The meeting starts when it is ready.',
        );
    }
    store.setModelProgress(p.total ? Math.min(1, p.received / p.total) : 0);
  });
  return () => {
    offText();
    offError?.();
    offProgress?.();
    store.setModelProgress(null);
  };
}

async function beginCapture(chatId: string, opts: { names?: boolean } = {}): Promise<void> {
  // 'new' is the new-chat screen's placeholder, not a chat: no host owns it, so
  // the server would drop every control frame and line sent for it.
  if (chatId === 'new') throw new Error('Send a first message to create the chat, then start it');
  const bridge = deviceTranscriber();
  stopListening?.();
  stopListening = listen(chatId, bridge);
  try {
    // The first meeting downloads the speech model; nothing is captured until it is ready.
    await bridge.startMeetingTranscription();
  } catch (err) {
    stopListening();
    stopListening = null;
    throw new Error(`Speech model unavailable: ${(err as Error).message}`);
  }
  useMeetingStore.getState().setModelProgress(null);
  const sources = await acquireSources(opts);
  try {
    capture = startMeetingCapture(
      sources,
      (source, pcm) => bridge.pushMeetingAudio(source, pcm, Date.now()),
      // A long silence from the far end: the call is over.
      { onSilence: () => void endMeeting(chatId) },
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

export async function startMeeting(chatId: string, opts: { names?: boolean } = {}): Promise<void> {
  try {
    await beginCapture(chatId, opts);
    ws().send({
      type: 'meeting.control_request',
      chatId,
      action: 'start',
      settings: speedSettings(getMeetingSpeed()),
    });
  } catch (err) {
    void stopCapture();
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

/** Show `name` for a `Them N` voice, e.g. once Tom has recognised who it is. */
export function nameMeetingVoice(chatId: string, voice: number, name: string): void {
  ws().send({ type: 'meeting.control_request', chatId, action: 'name_voice', voice, name });
}

export async function pauseMeeting(chatId: string): Promise<void> {
  capture?.setPaused(true);
  // What was being said as Pause was pressed still belongs to the meeting.
  await getDesktopBridge()
    ?.flushMeetingTranscription?.()
    .catch((err: unknown) => report('Transcription failed', err));
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
    void stopCapture();
    report('Could not resume the meeting', err);
  }
}

/** Waits for the last words to be transcribed and sent, so they reach the host ahead of `end`. */
export async function endMeeting(chatId: string): Promise<void> {
  await stopCapture();
  ws().send({ type: 'meeting.control_request', chatId, action: 'end' });
}

/** Removes an ended meeting from the chat; the host answers with `meeting.state` null. */
export function deleteMeeting(chatId: string): void {
  ws().send({ type: 'meeting.control_request', chatId, action: 'delete' });
}

export function decideAction(
  chatId: string,
  actionId: string,
  decision: 'do' | 'chat' | 'dismiss' | 'done' | 'reopen',
): void {
  ws().send({ type: 'meeting.action_request', chatId, actionId, decision });
}

/** Hands someone else's action to a speaker, or `Everyone`. */
export function setActionOwner(chatId: string, actionId: string, owner: string): void {
  ws().send({ type: 'meeting.action_request', chatId, actionId, owner });
}

/** Hands an action to Tom (`mine`), the agent (`agent`) or someone else (`other` with `owner`). */
export function assignAction(
  chatId: string,
  actionId: string,
  kind: MeetingAction['kind'],
  owner?: string,
): void {
  ws().send({
    type: 'meeting.action_request',
    chatId,
    actionId,
    assign: { kind, ...(owner !== undefined ? { owner } : {}) },
  });
}

/** Rewrites an action's text. */
export function setActionTitle(chatId: string, actionId: string, title: string): void {
  ws().send({ type: 'meeting.action_request', chatId, actionId, title });
}

/** An action Tom writes himself. */
export function addAction(
  chatId: string,
  title: string,
  kind: MeetingAction['kind'],
  owner?: string,
): void {
  ws().send({
    type: 'meeting.action_request',
    chatId,
    add: { title, kind, ...(owner !== undefined ? { owner } : {}) },
  });
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

/**
 * Rewrites the notes text and shows it at once; the host stores it and its
 * `meeting.state` echo confirms. Throws when the chat has no meeting.
 */
function writeNotes(chatId: string, next: (m: MeetingState) => string): void {
  const store = useMeetingStore.getState();
  const m = store.byChat[chatId];
  if (!m) throw new Error(`chat ${chatId} has no meeting`);
  const text = next(m);
  saveMyNotes(chatId, text);
  store.apply(chatId, { ...m, myNotes: text });
}

/** A note from the composer's Note mode, timed at this moment of the meeting. */
export function addNote(chatId: string, text: string): void {
  writeNotes(chatId, (m) => addMeetingNote(m.myNotes ?? '', meetingElapsedMs(m, Date.now()), text));
}

/** Rewrites one note in place; empty text removes it. */
export function editNote(chatId: string, index: number, text: string): void {
  writeNotes(chatId, (m) => editMeetingNote(m.myNotes ?? '', index, text));
}

/** The edited final write-up; the host stores it and answers with `meeting.state`. */
export function saveWriteup(chatId: string, writeup: MeetingWriteup): void {
  ws().send({ type: 'meeting.writeup_request', chatId, writeup });
}

export function requestMeeting(chatId: string): void {
  getActiveWs()?.send({ type: 'meeting.get_request', chatId });
}

/** Stops hearing; resolves once everything already heard has been transcribed and sent. */
async function stopCapture(): Promise<void> {
  const had = capture;
  capture?.stop();
  capture = null;
  const bridge = getDesktopBridge();
  if (had && bridge?.stopMeetingTranscription) {
    await bridge
      .stopMeetingTranscription()
      .catch((err: unknown) => report('Transcription failed', err));
  }
  stopSpeakerWatch?.();
  stopSpeakerWatch = null;
  stopListening?.();
  stopListening = null;
  useMeetingStore.getState().setCapturing(null);
}

/** Test seam. */
export function __resetMeetingControlForTests(): void {
  capture = null;
  stopListening = null;
}
