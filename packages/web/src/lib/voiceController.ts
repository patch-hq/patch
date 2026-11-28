// voiceController — bridges the voice gestures (mode 1/2/3) to the audio plane
// (lib/audioSession.ts) and the voiceStore. Components call these functions;
// the controller owns the AudioSession lifecycle and routes audio-plane
// callbacks into the store so the overlays render live state.
//
// spec/07 ## Voice-input modes / ## Barge-in / ## Permission prompts during
// voice / ## Focus-follow.

import { callClock } from './callClock.js';
import { getActiveWs } from '../api/ws.js';
import { playCallSound, syncCallSoundLoop } from './callSound.js';
import { CallLine, type CallLinePhase } from '@patch/wire/call-line';
import { openAudioSession, type AudioSessionDeps } from './audioSession.js';
import type { AudioSessionMode } from '@patch/wire/audio';
import { startDictationPreview, type DictationPreview } from './dictationPreview.js';
import { startRecording, type VoiceRecording, type VoiceRecorderDeps } from './voiceRecorder.js';
import { api } from '../api/rest.js';
import { useVoiceStore, type VoiceNoteGesture } from '../stores/voiceStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { addressWordOrNull, usePreferencesStore } from '../stores/preferencesStore.js';
import type { PauseReason } from '../stores/voiceStore.js';
import { watchCallHeadphones } from './callHeadphones.js';
import { failed } from './errorCopy.js';
import {
  endDirectCall,
  pauseDirectCall,
  resumeDirectCall,
  setDirectCallMuted,
} from './direct/directCall.js';

// The looping call sounds follow the call's state (spec/07 § Call sounds):
// connecting until the call is ready, reconnecting while a dropped
// line redials, and the agent ringing while an incoming call waits.
useVoiceStore.subscribe((s) => {
  const call = s.call;
  // A paused call holds no session and is not being placed: it makes no sound,
  // and an agent's call rings over it (spec/07 § Pause).
  const live = call !== null && call.paused === null;
  // Connecting lasts until the call is ready: a voice agent call's first state
  // past `connecting` from the host, which holds it there until the provider has
  // set up (ElevenLabs takes seconds after the socket opens), or a direct call's
  // microphone opening (it has no session to the host at all).
  syncCallSoundLoop('connecting', live && !call.reconnecting && call.phase === 'connecting');
  syncCallSoundLoop('reconnecting', live && call.reconnecting);
  syncCallSoundLoop('agent-calling', s.incomingCall !== null && !live);
  syncCallSoundLoop('agent-working', live && (call.direct?.status.workingSince ?? null) !== null);
});

/** Test seam: inject the audio-session opener (defaults to the real one). Used
 *  by the CALL path (mode 2/3), which is genuinely bidirectional/streaming. */
type Opener = typeof openAudioSession;
let openImpl: Opener = openAudioSession;
export function __setAudioOpenerForTests(o: Opener | null): void {
  openImpl = o ?? openAudioSession;
}

/** Test seam: inject the mic recorder factory used by the NOTE path (mode 1). */
type RecorderFactory = (deps?: VoiceRecorderDeps) => Promise<VoiceRecording>;
let recorderImpl: RecorderFactory = startRecording;
export function __setRecorderFactoryForTests(r: RecorderFactory | null): void {
  recorderImpl = r ?? startRecording;
}

/** Test seam: inject the live-transcript session opener for the NOTE path. */
let previewImpl: typeof startDictationPreview = startDictationPreview;
export function __setPreviewFactoryForTests(p: typeof startDictationPreview | null): void {
  previewImpl = p ?? startDictationPreview;
}

// The in-flight note recording (null until the mic has finished spinning up).
let activeRecording: VoiceRecording | null = null;
// The live-transcript leg tee'd off that recording (spec/07 § Live transcript).
let activePreview: DictationPreview | null = null;

/** Close the note's live-transcript leg, if one is open. Never commits a turn. */
function endNotePreview(): void {
  activePreview?.stop();
  activePreview = null;
}

function speakerFor(chatId: string): string {
  const chat = useChatStore.getState().chats[chatId];
  return (chat?.name ?? 'AGENT').toUpperCase();
}

/**
 * Turn an audio-plane error string (`<code>: <message>`) into a user-facing
 * toast. The host plays the agent's replies back as TTS via Kokoro; when that
 * backend isn't running on the agent host it fails the turn with
 * `kokoro_unavailable` — the call then has no talk-back, which is exactly the
 * "call doesn't speak" symptom. Report the INFRA dependency precisely (NO
 * FALLBACK / no faked speech) instead of a cryptic code, so it's actionable.
 */
export function describeCallError(m: string): string {
  if (m.includes('kokoro_unavailable')) {
    return (
      'voice call: text-to-speech is unavailable — the Kokoro TTS service is not running on ' +
      'the agent host, so replies can’t be spoken. Start the kokoro-sidecar (KOKORO_BACKEND=real ' +
      'needs KOKORO_MODEL_PATH set to the kokoro-onnx model on disk; the host then serves it on ' +
      `127.0.0.1:5019). Original error — ${m}`
    );
  }
  return `voice call: ${m}`;
}

// --------------------------------------------------------------------------
// Mode 1 — voice note (single turn)
// --------------------------------------------------------------------------

/**
 * Tee the note's recording into a host audio session so the overlay paints the
 * interim transcript while the user is still speaking (spec/07 § Live
 * transcript). Strictly additive: the clip and the transcript uploaded from it
 * are what the note actually sends. A failure here is reported, never swallowed,
 * and never aborts the recording it decorates.
 */
function startNotePreview(chatId: string, rec: VoiceRecording): void {
  const fail = (message: string): void =>
    useUiStore
      .getState()
      .pushError(`voice note: live transcript unavailable (still recording): ${message}`);
  try {
    const preview = previewImpl(chatId, {
      onPartial: (text) => {
        // A stale leg (note ended or replaced) must not paint into the next note.
        if (activePreview === preview) useVoiceStore.getState().setNoteTranscript(text);
      },
      onPreviewError: fail,
    });
    activePreview = preview;
    rec.onPcm((pcm) => activePreview?.push(pcm));
  } catch (err) {
    activePreview = null;
    fail((err as Error).message);
  }
}

/**
 * Begin a voice-note overlay targeting `chatId`. `gesture` records whether the
 * user is press-and-holding (release sends) or toggled a Superwhisper-style
 * session (⏎ sends). Starts recording the mic LOCALLY (record-and-upload) — it
 * does NOT open the streaming audio WSS. `sendVoiceNote` uploads the clip and
 * echoes the transcript the HTTP response returns.
 *
 * WHY UPLOAD, NOT WSS-STREAM: the streaming path only rendered the user's own
 * words if the host streamed an `audio.transcript_final` back over the audio
 * WSS and the client echoed it. On prod the audio plane is flaky (Kokoro/STT
 * partials aren't emitted), so the final never arrived and the spoken message
 * NEVER appeared — even though a reply came back. The upload path takes the
 * transcript straight from the `POST /api/voice/note` response, exactly like
 * the reliable mobile path, so it has no such dependency. NO FALLBACK: a failed
 * record/upload is surfaced loudly, never a silent no-op.
 *
 * `prefix` is whatever was already typed into the composer this note was started
 * from: starting a note must never throw those words away, so they lead the
 * committed turn and the transcript is appended to them (spec/07 § 1. Voice
 * note). Notes started where there is no composer pass nothing.
 */
export async function startVoiceNote(
  chatId: string,
  gesture: VoiceNoteGesture,
  prefix: string = '',
  deps?: VoiceRecorderDeps,
): Promise<void> {
  const store = useVoiceStore.getState();
  if (store.note || store.call) return; // already in a voice interaction
  store.startNote(chatId, gesture, prefix);
  activeRecording = null;
  await (async () => {
    try {
      const rec = await recorderImpl(deps);
      // The overlay may have been cancelled while the mic was spinning up.
      if (useVoiceStore.getState().note === null) {
        rec.cancel();
        return;
      }
      rec.onLevel((l) => useVoiceStore.getState().setNoteLevel(l));
      activeRecording = rec;
      startNotePreview(chatId, rec);
    } catch (err) {
      activeRecording = null;
      useUiStore.getState().pushError(failed('voice note'), undefined, (err as Error).message);
      useVoiceStore.getState().endNote();
    }
  })();
}

/**
 * Commit the in-flight voice note: stop the mic, upload the clip to
 * `POST /api/voice/note` (the server transcribes it via the host's Whisper
 * and injects the turn), then echo the RETURNED transcript into the timeline.
 *
 * Echoing the HTTP-returned transcript — rather than a value the host streamed
 * over the audio WSS — is the real fix: the host streams back ONLY the
 * assistant reply, never a live echo of the user's own input, and the audio
 * plane is flaky on prod. Reuses the typed-input path (addLocalMessage) with a
 * localId, so the persisted `[voice • web]` copy reconciles against it by
 * content on replay (chatStore.stripVoicePrefix) instead of duplicating.
 */
export async function sendVoiceNote(): Promise<void> {
  const store = useVoiceStore.getState();
  const note = store.note;
  // A second commit (⏎ and the mic, key repeat) while one is uploading would
  // send the same note twice.
  if (!note || note.sending) return;
  const chatId = note.chatId;
  store.setNoteSending(true);
  const rec = activeRecording;
  activeRecording = null;
  endNotePreview();
  if (!rec) {
    // The gesture was released before the mic finished spinning up, so there is
    // no clip to send. Never drop a send silently; tell the user to hold longer.
    // (endNote also makes the still-in-flight start cancel its late recording —
    // it re-checks `note === null` once the mic is ready.)
    useUiStore
      .getState()
      .pushError('voice note: nothing recorded (released too quickly?). Hold a beat longer.');
    // The turn is never going to be delivered, so the text this note lifted out
    // of the composer goes straight back into it (NO FALLBACK — a note that does
    // not send must not cost the user the words he had already typed).
    useVoiceStore.getState().restoreComposerText(chatId, note.prefix);
    useVoiceStore.getState().endNote();
    return;
  }
  // APPEAR LIVE (the user, patch/todo.md): drop the message bubble into the timeline
  // the INSTANT the user finishes speaking, in a live "Transcribing…" state, so
  // it shows immediately rather than only after the upload + Whisper round-trip
  // (a long dead gap on slow/train internet). The same bubble (keyed by localId)
  // fills in with the recognised text when the upload returns.
  const localId = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const chat = useChatStore.getState();
  chat.addTranscribingMessage(chatId, localId);
  try {
    const clip = await rec.stop();
    // `text` is the turn the server actually injected — the typed prefix plus
    // the transcript. Echoing THAT (not the bare transcript) is what lets the
    // persisted `[voice • web]` copy reconcile by content instead of duplicating.
    const { text } = await api.voiceNote(chatId, clip, note.prefix);
    // Fill (or, for an empty transcript, drop) the live bubble in place. Keeps
    // the localId so the persisted `[voice • web]` copy reconciles by content on
    // replay instead of duplicating; the upload returned 200 (turn delivered),
    // so it never lingers as "Sending…".
    useChatStore.getState().resolveTranscription(chatId, localId, text);
  } catch (err) {
    // NO orphaned live placeholder: remove the transcribing bubble and surface
    // the failure loudly (NO FALLBACK), never a silent stuck "Transcribing…".
    useChatStore.getState().cancelTranscription(chatId, localId);
    useUiStore.getState().pushError(failed('voice note'), undefined, (err as Error).message);
    // The typed text rode along as the note's prefix and the turn never landed,
    // so it is owed back to the composer. Without this, a failed upload silently
    // eats a half-written message — the exact loss this change exists to stop
    // (Todoist: "erases the current content of text when you start a voice
    // note"). It is handed back BEFORE `endNote` in the `finally` below, which
    // deliberately does not clear it.
    useVoiceStore.getState().restoreComposerText(chatId, note.prefix);
  } finally {
    useVoiceStore.getState().endNote();
  }
}

/**
 * Tap (not hold) gesture: a press released quickly was NOT a press-and-hold —
 * promote the in-flight note to a Superwhisper-style sustained toggle session
 * (spec/07 ## Voice-input modes — mode 1, gesture b). The overlay stays up in
 * persistent LISTENING mode; the audio session keeps streaming; the user sends
 * with ⏎ (or by tapping the control again) and cancels with Esc. The audio
 * plane is identical to PTT — only the commit trigger differs — so there is
 * nothing to re-open; we just re-tag the gesture.
 */
export function promoteNoteToToggle(): void {
  const store = useVoiceStore.getState();
  if (!store.note) return;
  store.setNoteGesture('toggle');
}

/**
 * A press shorter than this is a "tap" (opens a sustained toggle session), not
 * a press-and-hold (release commits). Shared by every control that can start a
 * note — the composer/sidebar mic buttons and the ⌘; / ⌃Space hotkeys — so the
 * gesture means the same thing whichever one the user reached for.
 */
export const TAP_THRESHOLD_MS = 220;

/**
 * End a press-and-hold gesture that lasted `heldMs`: commit the note, or, if
 * the press was too short to be one, promote it to a sustained toggle session
 * (spec/07 ## Voice-input modes — mode 1).
 *
 * The keyboard hotkeys NEED the threshold as much as the mic buttons do. ⌘; is
 * a chord: it is struck and released in ~100ms, which is shorter than any
 * utterance. Committing on the bare keyup uploaded a ~100ms clip and the note
 * died instantly on a failed transcription — the hotkey could not be used at
 * all. Below the threshold the session therefore stays OPEN and keeps
 * listening; ⏎ commits it and esc drops it.
 *
 * Only a `ptt` note is ever committed here. A note already retagged `toggle` is
 * the user's open dictation session, and a keyup that arrives late (macOS does
 * not deliver one for a character key while ⌘ is held, so it lands whenever the
 * modifier is finally released) must not end it under them.
 */
export function releaseVoiceNoteHold(heldMs: number): void {
  const note = useVoiceStore.getState().note;
  if (!note || note.gesture !== 'ptt') return;
  if (heldMs < TAP_THRESHOLD_MS) {
    promoteNoteToToggle();
    return;
  }
  void sendVoiceNote();
}

/** Esc / abort: drop the note WITHOUT uploading the recorded clip. */
export function cancelVoiceNote(): void {
  activeRecording?.cancel();
  activeRecording = null;
  endNotePreview();
  // Cancelling the NOTE cancels the note, not the message the user had already
  // written. Anything the note carried as its prefix goes back to the composer.
  const note = useVoiceStore.getState().note;
  if (note) useVoiceStore.getState().restoreComposerText(note.chatId, note.prefix);
  // Clearing the note first also makes a still-in-flight start (notePrepare)
  // cancel its late recording (it checks `note === null` after the mic spins up).
  useVoiceStore.getState().endNote();
}

// --------------------------------------------------------------------------
// Mode 2 & 3 — voice call (persistent) / focus-follow
// --------------------------------------------------------------------------

/**
 * Open a persistent bidirectional voice call on `chatId`.
 *
 * `mode` (spec/07 § Session modes) is what the session opens in: `call` is the
 * phone call, `waiting` is a call with gaps, `working` is the locked-phone mode
 * that stays open and silent until it has something to say. All three are the
 * SAME session; `setCallMode` moves between them without tearing anything down.
 */
export async function startVoiceCall(
  chatId: string,
  mode: AudioSessionMode = 'call',
  deps?: AudioSessionDeps,
  opts: { takeOver?: boolean; callReason?: string } = {},
): Promise<void> {
  // A paused call holds no session (spec/07 § Pause): a new call replaces it.
  if (useVoiceStore.getState().call?.paused != null) endVoiceCall({ silent: true });
  const store = useVoiceStore.getState();
  if (store.call) {
    // Already on a call: it stays on the chat it was started on, wherever the user goes.
    return;
  }
  store.endNote();
  store.startCall(chatId, mode);
  await placeCall(chatId, deps, opts);
}

/**
 * Put a line under the call in the store and dial it: a new call, or a paused
 * one resuming (a fresh session, not a redial — nothing dropped).
 */
async function placeCall(
  chatId: string,
  deps: AudioSessionDeps | undefined,
  opts: { takeOver?: boolean; callReason?: string },
): Promise<void> {
  let firstDial: Promise<void> = Promise.resolve();
  const l: CallLine = new CallLine(
    {
      dial: (attempt, resumed) => {
        // A redial goes to the chat the call is on now: the voice agent may have switched it.
        const onChat = useVoiceStore.getState().call?.chatId ?? chatId;
        const opening = openCallSession(l, attempt, onChat, deps, {
          takeOver: opts.takeOver === true && attempt === 1,
          resumed,
          // Never repeated on a redial: the voice already opened with it.
          ...(opts.callReason !== undefined && !resumed ? { callReason: opts.callReason } : {}),
        });
        if (attempt === 1) firstDial = opening;
      },
      hangUp: (attempt) => {
        if (sessionAttempt !== attempt) return;
        const s = useVoiceStore.getState().session;
        useVoiceStore.getState().setSession(null);
        s?.end('lost');
      },
      send: (attempt, frame) => {
        const s = useVoiceStore.getState().session;
        return sessionAttempt === attempt && s !== null && s.send(frame);
      },
      phase: onLinePhase,
      stillTrying: (reason) => {
        useUiStore.getState().pushError(`${describeCallError(reason)} — still trying`);
      },
    },
    callClock,
  );
  line = l;
  watchCallEnvironment(l);
  l.start();
  await firstDial;
}

/**
 * The open call's line (spec/07 § A dropped call comes back): it decides when
 * an attempt is live or lost, redials, and keeps the call log. This module
 * opens each attempt's session and plays what the line says.
 */
let line: CallLine | null = null;
/** The attempt whose session is in the store. */
let sessionAttempt = 0;
let unwatchEnvironment: (() => void) | null = null;

/**
 * What the page can tell the line: coming back into view redials a waiting
 * line at once, and the browser's audio devices changing goes into the log.
 */
function watchCallEnvironment(l: CallLine): void {
  unwatchEnvironment?.();
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') l.foreground();
  };
  const onDevices = (): void => l.audioStopped('output_device_changed', 'audio devices changed');
  document.addEventListener('visibilitychange', onVisible);
  const media = (navigator as { mediaDevices?: MediaDevices }).mediaDevices;
  media?.addEventListener?.('devicechange', onDevices);
  unwatchEnvironment = () => {
    document.removeEventListener('visibilitychange', onVisible);
    media?.removeEventListener?.('devicechange', onDevices);
  };
}

function onLinePhase(next: CallLinePhase, prev: CallLinePhase, reason?: string): void {
  const store = useVoiceStore.getState();
  if (next === 'live') {
    store.setCallReconnecting(false);
    playCallSound(prev === 'reconnecting' ? 'reconnected' : 'connected');
    heardSomething();
    return;
  }
  if (next === 'reconnecting') {
    // Nothing said while the line is down is kept: the dead attempt's
    // session goes, and the redial opens a fresh one.
    store.setCallReconnecting(true);
    const dead = store.session;
    store.setSession(null);
    dead?.end('lost');
    store.setCallPhase('connecting');
    return;
  }
  // failed — loud, and the call is over. NO FALLBACK.
  useUiStore.getState().pushError(describeCallError(reason as string));
  playCallSound('failed');
  endVoiceCall({ silent: true });
}

async function openCallSession(
  l: CallLine,
  attempt: number,
  chatId: string,
  deps: AudioSessionDeps | undefined,
  opts: { takeOver: boolean; resumed: boolean; callReason?: string },
): Promise<void> {
  const addressWord = addressWordOrNull();
  const current = (): boolean => line === l && l.isCurrent(attempt);
  try {
    const session = await openImpl({
      chatId,
      role: 'voice-call',
      mode: useVoiceStore.getState().call?.mode ?? 'call',
      ...(addressWord !== null ? { addressWord } : {}),
      ...(opts.takeOver ? { takeOver: true } : {}),
      ...(opts.resumed ? { resumed: true } : {}),
      ...(opts.callReason !== undefined ? { callReason: opts.callReason } : {}),
      deps: deps ?? {},
      callbacks: {
        onTranscriptPartial: (t) => {
          if (!current()) return;
          heardSomething();
          const s = useVoiceStore.getState();
          s.setCallTranscript(t);
          s.setCallLine('YOU', t);
        },
        onTranscriptFinal: (t, addressed) => {
          // Not gated on the session being current: words the host already
          // committed land in the chat even if the call was paused or ended.
          if (current()) heardSomething();
          const s = useVoiceStore.getState();
          s.setCallTranscript('');
          // Heard but not sent (spec/07 § Session modes): show it greyed so the
          // user can see the mic is alive and see why nothing happened, and do
          // NOT echo it into the chat — it never became a turn.
          if (!addressed) {
            s.setCallUnaddressed(t);
            return;
          }
          l.turn('transcript');
          s.setCallUnaddressed(null);
          s.setCallLine('YOU', t);
          // Echo the spoken turn into the chat timeline — a call has no composer
          // to render it optimistically, so without this the user never sees
          // what they said. Reuses the typed-input path (addLocalMessage), so it
          // reconciles with the persisted copy on replay by content + localId.
          const text = t.trim();
          if (text) {
            const target = s.call?.chatId ?? chatId;
            const localId = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const store = useChatStore.getState();
            store.addLocalMessage(target, text, localId, undefined, undefined, {
              dedupeAgainstPersisted: true,
            });
            // The spoken turn is already committed to the host, and this echo is
            // not deliveryTracker-managed (no live user `chat.message` will clear
            // it), so retire the optimistic "Sending…" mark immediately — otherwise
            // it sticks forever next to a completed reply (same fix as the note path).
            store.clearDelivery(target, localId);
          }
        },
        onState: (st, sessionId) => {
          // The host's first turn state is it acknowledging the session.
          if (st !== 'connecting') l.acked(attempt, sessionId);
          if (st === 'transcribing') l.turn('speech_end');
          if (current()) useVoiceStore.getState().setCallPhase(st);
        },
        onTtsStart: () => {
          if (!current()) return;
          heardSomething();
          const s = useVoiceStore.getState();
          const target = s.call?.chatId ?? chatId;
          s.setCallSpeaking(true);
          s.setCallLine(speakerFor(target), '');
        },
        onReplyAudio: () => l.turn('reply_audio'),
        onTtsEnd: () => {
          if (!current()) return;
          heardSomething();
          l.turn('reply_end');
          useVoiceStore.getState().setCallSpeaking(false);
        },
        onBargeIn: () => {
          // User spoke over the agent — TTS is cut host-side; reflect the
          // 'listening' state so the user never sees a hung audio session.
          if (!current()) return;
          const s = useVoiceStore.getState();
          s.setCallSpeaking(false);
          s.setCallLine('YOU', '');
        },
        onLevel: (lv) => useVoiceStore.getState().setCallLevel(lv),
        onNotice: (m) => useUiStore.getState().pushError(m),
        onChatSwitched: (id) => useVoiceStore.getState().setCallChat(id),
        onPassedToAgent: () => playCallSound('passed-to-agent'),
        onHeartbeat: (frame) => l.heartbeat(attempt, frame),
        onError: (m) => {
          // The host went away under the call (it restarted, or the server
          // lost it): the line is lost, not failed. Every other error is one
          // the host ends the call on.
          if (m.startsWith('host_unreachable')) l.lost(attempt, 'host_unreachable', m);
          else l.fail(attempt, m);
        },
        onClose: (reason) => {
          // The host only ends a call itself when it moves to another device
          // or the agent hangs up; any other close is the line dropping, and
          // the line decides what that means.
          if (!current()) return;
          if (reason === 'transferred' || reason === 'ended_by_agent') {
            endVoiceCall();
            return;
          }
          l.lost(attempt, 'connection_closed', 'Call dropped — the audio connection closed');
        },
      },
    });
    if (!current()) {
      session.end('cancelled');
      return;
    }
    sessionAttempt = attempt;
    useVoiceStore.getState().setSession(session);
  } catch (err) {
    // A first dial that cannot open has failed; a redial tries again (the line decides).
    l.lost(attempt, 'connection_closed', (err as Error).message);
  }
}

/**
 * Take over the call another surface holds on `chatId`: the host ends it there
 * and this surface opens its own (spec/07 § A call can move between devices).
 */
export function switchCallHere(chatId: string, deps?: AudioSessionDeps): Promise<void> {
  return startVoiceCall(chatId, 'call', deps, { takeOver: true });
}

/** End the chat's call on whichever other surface holds it (spec/07 § A call can move between devices). */
export function endRemoteCall(chatId: string): void {
  const ws = getActiveWs();
  if (!ws) throw new Error('Cannot end the call: not connected to the server');
  ws.send({ type: 'voice.end_call_request', chatId });
}

/**
 * Move the open session between modes (spec/07 § Session modes). One session,
 * three policies — nothing is torn down or reopened.
 */
export function setCallMode(next: AudioSessionMode): void {
  const store = useVoiceStore.getState();
  if (!store.call) return;
  if (store.call.mode === next) return;
  store.setCallMode(next);
  heardSomething();
  store.setCallUnaddressed(null);
  store.session?.setSessionMode(next);
}

export function toggleCallMute(): void {
  const store = useVoiceStore.getState();
  if (!store.call) return;
  const next = !store.call.muted;
  store.setCallMuted(next);
  store.session?.setMuted(next);
  setDirectCallMuted(next);
}

export function endVoiceCall(opts: { silent?: boolean } = {}): void {
  // The line's log goes to the host while the session is still open, then the
  // line stops: nothing it hears after this counts.
  line?.end();
  line = null;
  unwatchEnvironment?.();
  unwatchEnvironment = null;
  clearQuietTimer();
  const store = useVoiceStore.getState();
  if (store.call !== null && opts.silent !== true) playCallSound('ended');
  // Clear the call first: ending the session can close its socket, and the close
  // handler must find no call left to announce a second time.
  const session = store.session;
  endDirectCall();
  store.endCall();
  store.setSession(null);
  session?.end('ended');
}

// --------------------------------------------------------------------------
// Pause (spec/07 § Pause)
// --------------------------------------------------------------------------

/**
 * Pause the call: a soft hang-up. The voice session closes, so nothing listens
 * and nothing is billed, but the call stays on the bar to resume on the same
 * chat. The host announces the session ended, so other devices do not show a
 * paused call as live, and an agent's call rings rather than speaking into it.
 */
export function pauseVoiceCall(reason: PauseReason = 'button'): void {
  const store = useVoiceStore.getState();
  if (store.call === null || store.call.paused !== null) return;
  // The line stops: its log goes to the host on the closing session, and that
  // session's callbacks are no longer this call's.
  line?.end();
  line = null;
  unwatchEnvironment?.();
  unwatchEnvironment = null;
  clearQuietTimer();
  const session = store.session;
  store.setSession(null);
  store.setCallPaused(reason);
  store.setCallReconnecting(false);
  store.setCallSpeaking(false);
  store.setCallTranscript('');
  store.setCallUnaddressed(null);
  playCallSound('paused');
  session?.end('paused');
  pauseDirectCall();
}

/**
 * Resume a paused call: a new session on the same chat with a fresh start
 * context, so a resume is not a redial (`resumed` stays off — nothing dropped).
 */
export async function resumeVoiceCall(deps?: AudioSessionDeps): Promise<void> {
  const store = useVoiceStore.getState();
  const call = store.call;
  if (call === null || call.paused === null) return;
  store.setCallPaused(null);
  store.setCallPhase('connecting');
  if (call.direct) await resumeDirectCall();
  else await placeCall(call.chatId, deps, {});
}

/**
 * Pause when quiet for (Settings → Voice calls; spec/07 § Pause): a live call in
 * which nothing has been said by either side for that long pauses. Every word
 * heard or spoken re-arms it. Hands-free is left alone — it is a line left open
 * on purpose and never ends itself on silence (spec/07 § Session modes).
 */
// On the call's clock: a quiet call is usually one in a tab nobody is looking at.
let quietTimer: unknown = null;

function clearQuietTimer(): void {
  if (quietTimer !== null) callClock.clearTimeout(quietTimer);
  quietTimer = null;
}

/** Something was said on the call (or it just went live): start the quiet clock again. */
function heardSomething(): void {
  clearQuietTimer();
  const minutes = usePreferencesStore.getState().preferences.pauseWhenQuietMinutes;
  const call = useVoiceStore.getState().call;
  if (minutes === 0 || call === null || call.paused !== null || call.mode !== 'call') return;
  quietTimer = callClock.setTimeout(() => {
    quietTimer = null;
    const now = useVoiceStore.getState().call;
    // A reply still playing is not silence; look again once it has finished.
    if (now?.agentSpeaking === true) {
      heardSomething();
      return;
    }
    pauseVoiceCall('quiet');
  }, minutes * 60_000);
}

/**
 * Headphones out pauses the call and back in resumes it (spec/07 § Pause). The
 * watch lasts as long as the call does — through a pause, since putting the
 * headphones back is what resumes it.
 */
let stopHeadphoneWatch: (() => void) | null = null;
useVoiceStore.subscribe((s, prev) => {
  if (s.call !== null && prev.call === null) {
    const mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    if (mediaDevices === undefined) return; // no audio devices at all: nothing to come or go
    stopHeadphoneWatch = watchCallHeadphones({
      mediaDevices,
      onGone: () => pauseVoiceCall('headphones'),
      onBack: () => {
        if (useVoiceStore.getState().call?.paused === 'headphones') void resumeVoiceCall();
      },
    });
  } else if (s.call === null && prev.call !== null) {
    stopHeadphoneWatch?.();
    stopHeadphoneWatch = null;
    clearQuietTimer();
  }
});
