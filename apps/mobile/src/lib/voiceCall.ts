// Voice-call session: calls POST /api/voice/token, opens the audio WSS
// session, starts the Android VoiceAudioService foreground notification,
// and updates the voice store so the in-chat call bar (CallStrip) and the
// on-call pill (CallStrip) render.
//
// IMPORTANT: the call bar MUST appear the instant the call control is
// tapped. Minting a token (api.me + api.voiceToken), requesting the mic
// permission and acquiring audio focus are all async and on a loaded
// emulator take seconds; doing them BEFORE flipping the store left the
// gesture looking dead ("tap does nothing"). So we mount the call bar
// synchronously in a CONNECTING state, then open the real session in the
// background and upgrade the store to the live session id / audio URL. Any
// failure releases the audio and keeps the bar up with the error and a Retry — NO FALLBACK.
//
// THE CALL'S AUDIO (spec/07 § A call keeps going in the background). The
// session itself — the audio socket, the microphone streaming up it as
// `audio.pcm16` frames, the echo of every host heartbeat, and playback of the
// reply's 24 kHz PCM — runs on native threads in the voice service
// (callTransport.ts → CallTransport.kt), never through this JS: React Native
// throttles it and stops its timers once the phone is locked or the app is in
// the background, and a call has to keep going there. This module opens each
// attempt, reads the host's control frames to drive the call bar and the line,
// and sends the few control frames JS owns (mode, call log, session end). The
// line keeps time on the native clock for the same reason. NO FALLBACK: a
// microphone or player that cannot start fails the call and says why.
//
// VOICE ENGINE (spec/07 § Voice — a config matrix). Nothing in this file is
// specific to the `local` pipeline. `gemini` (Gemini Live) and `openai` (OpenAI
// Realtime) are relayed by the HOST: the phone opens the same audio WSS,
// sends the same `audio.session_start` and the same 16 kHz PCM up, and plays the
// same 24 kHz PCM back through the same long-lived AudioTrack sink, and the
// host runs whichever engine the account's voice config names for this
// session. No provider key or ephemeral token ever reaches the phone, and no
// WebRTC module is needed. What the phone does with the voice agent setup: it
// names the provider and model on the call bar (`callEngineLabel`), and names
// the engine when one fails (`describeVoiceError`). Both modes run on the one
// voice agent, so a mode switch is always in place.

import { callEnds } from './callEnds';
import { playCallSound, syncCallSoundLoop } from './callSounds';
import { Audio } from 'expo-av';
import {
  AUDIO_NOTICE_CODES,
  decodeAudio,
  type AudioCallLogEvent,
  type AudioEvent,
  type AudioHeartbeatEvent,
  type AudioSessionMode,
} from '@patch/wire/audio';
import { CallLine, type CallLinePhase } from '@patch/wire/call-line';
import {
  flushCallPlayback,
  nativeCallClock,
  openCallTransport,
  type CallTransport,
} from './callTransport';
import { api } from '../api/rest';
import { audioWsUrl } from '../config';
import { useVoiceStore, type PauseReason } from '../stores/voiceStore';
import { useUiStore } from '../stores/uiStore';
import {
  startVoiceAudioService,
  stopVoiceAudioService,
  updateVoiceAudioService,
  onVoiceServiceAction,
  type VoiceServiceAction,
  type VoiceServiceState,
} from './voiceAudioService';
import {
  endDirectCall,
  pauseDirectCall,
  resumeDirectCall,
  setDirectCallMuted,
  startDirectCall,
} from './directCall';
import { addressWordOrNull, pauseWhenQuietMinutes, voiceAgentOrNull } from './preferences';
import { callEngineLabel, describeMicSilent, describeVoiceError } from './voiceEngine';
import { ensurePermission } from './permissionGate';
import { ensureVoiceReady } from './voiceReadiness';
import { useChatStore } from '../stores/chatStore';

export class VoiceAudioConnectError extends Error {
  override readonly name = 'VoiceAudioConnectError';
  override readonly cause?: Error;
  constructor(message: string, cause?: Error) {
    super(message);
    if (cause) this.cause = cause;
  }
}

/**
 * The open call's line (spec/07 § A dropped call comes back): it decides when
 * an attempt is live or lost, redials, and keeps the call log. This module
 * opens each attempt's session and plays what the line says.
 */
let _line: CallLine | null = null;
/** The open attempt's native session, and whether its socket is open. */
let _call: CallTransport | null = null;
let _callOpen = false;
/**
 * The call was answered on its own for an agent (Answer automatically in
 * hands-free): it holds transient audio focus, so the playback it paused
 * resumes when it ends. Kept for the call's life, across a pause.
 */
let _transientFocus = false;
/** The attempt `_call` belongs to. */
let _callAttempt = 0;
/** Unsubscribe for the notification-button listener, while a session is open. */
let _serviceActions: (() => void) | null = null;

// The looping call sounds follow the call's state (spec/07 § Call sounds):
// connecting while a call is first placed, reconnecting while a dropped line
// redials (from the bundled file, so it plays with no signal), and the agent
// ringing while an incoming call waits. Each stops the moment its state ends.
useVoiceStore.subscribe((s) => {
  const placing = s.activeSession !== null && s.callError === null && s.callPaused === null;
  const reconnecting = placing && s.callReconnectingSince !== null;
  syncCallSoundLoop('connecting', placing && !reconnecting && s.callPhase === 'connecting');
  syncCallSoundLoop('reconnecting', reconnecting);
  // A direct call's agent at work (spec/07 § Direct calls).
  syncCallSoundLoop(
    'agent-working',
    placing && (s.callDirect?.status.workingSince ?? null) !== null,
  );
  // An agent's call rings over a paused call (spec/07 § Pause), never over a live one.
  syncCallSoundLoop(
    'agent-calling',
    s.incomingCall !== null && (s.activeSession === null || s.callPaused !== null),
  );
});

// A call that has failed for good says so aloud, once.
let _failureCued = false;
useVoiceStore.subscribe((s) => {
  if (s.activeSession === null || s.callError === null) {
    _failureCued = false;
    return;
  }
  if (_failureCued) return;
  _failureCued = true;
  void playCallSound('failed');
});

/** Close the open attempt's session. */
function closeCall(): void {
  const call = _call;
  _call = null;
  _callOpen = false;
  call?.close();
}

/** Close the session of `attempt`, if it is still the open one. */
function closeAttempt(attempt: number): void {
  if (_callAttempt === attempt) closeCall();
}

/** Send a control frame on the open session; false when there is none. */
function sendFrame(frame: unknown): boolean {
  const call = _call;
  if (call === null || !_callOpen) return false;
  void call.send(frame).then(
    (sent) => {
      if (!sent) console.log(`[patch-voice] call frame not sent: the session has closed`);
    },
    (e: unknown) => console.log(`[patch-voice] call frame send failed: ${String(e)}`),
  );
  return true;
}

function sendOn(attempt: number, frame: AudioHeartbeatEvent | AudioCallLogEvent): boolean {
  return _callAttempt === attempt && sendFrame(frame);
}

/** Release every audio resource the call holds; keeps the store. */
async function releaseAudio(): Promise<void> {
  closeCall();
  _serviceActions?.();
  _serviceActions = null;
  await stopVoiceAudioService().catch(() => undefined);
}

/**
 * Silence on a line that is still open (spec/07 § A dropped call comes back):
 * the bar shows Lost contact and the reconnecting sound plays until the host is
 * heard again. Nothing is torn down; only the transport closing loses the line.
 */
function onLineContact(heard: boolean): void {
  useVoiceStore.getState().setCallReconnecting(!heard);
  if (heard) void playCallSound('reconnected');
}

function onLinePhase(next: CallLinePhase, prev: CallLinePhase, reason?: string): void {
  const st = useVoiceStore.getState();
  if (next === 'live') {
    st.setCallReconnecting(false);
    void playCallSound(prev === 'reconnecting' ? 'reconnected' : 'connected');
    return;
  }
  if (next === 'reconnecting') {
    // Nothing said while the line is down is kept: the dead attempt's session
    // took its microphone and playback with it, and the next attempt starts both afresh.
    st.setCallReconnecting(true);
    st.setCallPhase('connecting');
    return;
  }
  if (next === 'ended') {
    // The resume window ran out: the call ends, and never starts another by itself.
    void endVoiceCall();
    return;
  }
  // failed: the bar stays up naming why, with Retry and End. NO FALLBACK.
  const why = reason as string;
  console.log(`[patch-voice] call failed: ${why}`);
  st.setError(why);
  useUiStore.getState().pushError(`voice call: ${why}`);
  void releaseAudio();
}

/**
 * Open a sustained call on `chatId`.
 *
 * `mode` (spec/07 § Session modes) is what it opens in: `call` answers
 * everything you say; `hands-free` leaves the line open — it never ends itself
 * on silence, and only an addressed utterance is a turn. Both are the SAME
 * session; `setCallMode` flips between them without tearing anything down.
 */
export function startVoiceCall(
  chatId: string,
  mode: AudioSessionMode = 'call',
  opts: {
    takeOver?: boolean;
    /** Why the agent rang, on a call answering its `patch_call`: the voice opens with it. */
    callReason?: string;
    /** Answered on its own for an agent: take transient audio focus (see `_transientFocus`). */
    transientFocus?: boolean;
    /** Resuming this paused call: same call, so the same start and the service already up. */
    resume?: boolean;
  } = {},
): void {
  // spec/07 § Readiness — checked before dialling: a missing key or engine is
  // an invitation to set it up, not a call that fails. A call coming back from
  // a pause was ready when it began.
  if (
    opts.resume !== true &&
    !ensureVoiceReady(
      { feature: 'call', surface: mode === 'hands-free' ? 'hands-free' : 'call' },
      useChatStore.getState().chats[chatId]?.hostId,
    )
  ) {
    return;
  }
  _line?.end();
  clearQuietTimer();
  // A new call (not this one coming back from a pause) sets how it holds focus.
  if (opts.resume !== true) _transientFocus = opts.transientFocus === true;
  // 1) Mount the call bar synchronously — CONNECTING state, empty session. A
  // resume keeps its start, and connects afresh (the connected sound plays).
  useVoiceStore.getState().setActive({
    sessionId: '',
    chatId,
    audioUrl: '',
    startedAt:
      (opts.resume === true ? useVoiceStore.getState().activeSession?.startedAt : undefined) ??
      Date.now(),
  });
  useVoiceStore.getState().setCallMode(mode);
  useVoiceStore.getState().setCallAddressWord(addressWordOrNull());
  useVoiceStore.getState().setCallEngine(callEngineLabel(voiceAgentOrNull()));
  // Diagnostic (logcat ReactNativeJS) — proves the tap handler fired and the
  // call bar mounted synchronously in CONNECTING state.
  console.log(`[patch-voice] startVoiceCall chatId=${chatId} bar=connecting`);
  // 2) The line dials, and redials whenever it drops.
  const line: CallLine = new CallLine(
    {
      dial: (attempt, resumes) => {
        // A redial goes to the chat the call is on now: the voice agent may have switched it.
        const onChat = useVoiceStore.getState().activeSession?.chatId ?? chatId;
        void openAttempt(line, onChat, attempt, {
          takeOver: opts.takeOver === true && attempt === 1,
          resumes,
          // Never repeated on a redial: the voice already opened with it.
          ...(opts.callReason !== undefined && resumes === null
            ? { callReason: opts.callReason }
            : {}),
          // A paused call kept its service, and a redial never stopped it.
          serviceUp: opts.resume === true || resumes !== null,
        });
      },
      hangUp: closeAttempt,
      send: sendOn,
      phase: onLinePhase,
      contact: onLineContact,
    },
    nativeCallClock,
  );
  _line = line;
  line.start();
}

/** Open one attempt's session: token, permission, service, then the native session. */
async function openAttempt(
  line: CallLine,
  chatId: string,
  attempt: number,
  opts: { takeOver: boolean; resumes: string | null; callReason?: string; serviceUp: boolean },
): Promise<void> {
  const current = (): boolean => _line === line && line.isCurrent(attempt);
  try {
    // Identity is required in the host session_start frame; mint a
    // one-shot token bound to (this surface, chatId) for a sustained call.
    const addressWord = addressWordOrNull();
    const me = await api.me();
    const tok = await api.voiceToken(chatId, 'voice-call');
    if (!current()) return; // ended, replaced or timed out during the mint
    if (!tok.audioUrl) {
      throw new Error('server returned empty audioUrl');
    }
    console.log(
      `[patch-voice] call token minted sessionId=${tok.sessionId} audioUrl=${tok.audioUrl}`,
    );
    if (!(await ensurePermission('microphone'))) {
      throw new Error('mic permission denied');
    }
    if (!current()) return;
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      // Voice call wants AUDIOFOCUS_GAIN, not duck — but expo-av's API
      // only exposes the duck flag (KNOWN-GAP). Keep duck=false so the
      // call isn't ducked by other media; full GAIN requires a native
      // module on top of AudioManager.requestAudioFocus.
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: false,
    });
    if (!current()) return;

    // Upgrade the call bar to this attempt's session (real id + audio URL).
    // The timer keeps running off the call's own start.
    const startedAt = useVoiceStore.getState().activeSession?.startedAt ?? Date.now();
    useVoiceStore.getState().upgradeActive({
      sessionId: tok.sessionId,
      chatId,
      audioUrl: tok.audioUrl,
      startedAt,
    });
    console.log(
      `[patch-voice] voiceCall session live sessionId=${tok.sessionId} audioUrl=${tok.audioUrl}`,
    );

    // Foreground service holds phoneCall|microphone — required on Android
    // to keep the mic alive while CallKeep's UI is in foreground.
    // The mode and mute as they stand NOW: the bar is up from the tap, so the
    // user may have changed either while the token minted.
    await (opts.serviceUp
      ? updateVoiceAudioService(chatId, serviceState({ paused: false }))
      : startVoiceAudioService(chatId, {
          mode: useVoiceStore.getState().callMode,
          muted: useVoiceStore.getState().callMuted,
          transientFocus: _transientFocus,
        }));
    // The notification's own buttons are the control surface for a phone in a
    // pocket (spec/15 § Voice tab). Route them into the same state the
    // call bar drives, so the two can never disagree about what the session is
    // doing.
    _serviceActions?.();
    _serviceActions = onVoiceServiceAction(onServiceAction);
    if (!current()) {
      // Paused while the service came up: the call goes on, and its service and
      // listener are what headphones going back in will resume it through.
      if (useVoiceStore.getState().callPaused !== null) return;
      // Superseded while the service came up: the listener taken just above
      // is this attempt's own (nothing awaited since), and nobody else will
      // ever release it.
      _serviceActions?.();
      _serviceActions = null;
      if (_line !== line) await stopVoiceAudioService().catch(() => undefined);
      return;
    }

    // The session runs natively (callTransport.ts). The server returns a
    // RELATIVE `/audio/<id>` path, resolved against the audio plane (same-origin
    // in prod; the direct host port in dev). `audio.session_start` goes the
    // moment the socket opens, so the host binds the session without waiting on JS.
    const wsUrl = audioWsUrl(tok.audioUrl);
    const start = {
      type: 'audio.session_start' as const,
      sessionId: tok.sessionId,
      accountId: me.account.accountId,
      surfaceId: me.surface.surfaceId,
      surfaceKind: 'mobile' as const,
      chatId,
      role: 'voice-call' as const,
      token: tok.token,
      // The phone's microphone runs the platform echo cancel; the host bypasses its own.
      surfaceHasAec: true,
      mode: useVoiceStore.getState().callMode,
      ...(addressWord !== null ? { addressWord } : {}),
      ...(opts.takeOver ? { takeOver: true } : {}),
      ...(opts.resumes !== null ? { resumes: opts.resumes } : {}),
      ...(opts.callReason !== undefined ? { callReason: opts.callReason } : {}),
    };
    let replies = 0;
    // The open event can arrive before openCallTransport resolves.
    let opened = false;
    let call: CallTransport;
    try {
      call = await openCallTransport(wsUrl, start, {
        onOpen: () => {
          opened = true;
          if (_call !== null && _callAttempt === attempt) _callOpen = true;
          console.log(`[patch-voice] call session open ${wsUrl}; session_start sent, mic opening`);
        },
        onFrame: (text) => onHostFrame(line, attempt, tok.sessionId, text),
        onReplyAudio: (bytes) => {
          if (replies++ === 0) console.log(`[patch-voice] call first reply audio (${bytes}B)`);
          line.turn('reply_audio');
        },
        onMicError: (message) => {
          // LOUD + visible in the call bar — never a live-looking call that hears nothing.
          console.log(`[patch-voice] call microphone FAILED: ${message}`);
          line.fail(attempt, `mic failed: ${message}`);
        },
        onAudioStopped: (reason, detail) => {
          // The phone's own audio stopped under a live line: log why.
          console.log(`[patch-voice] call audio stopped (${reason}): ${detail}`);
          line.audioStopped(reason, detail);
        },
        onClose: ({ reason, error }) => {
          if (_callAttempt === attempt) {
            _call = null;
            _callOpen = false;
          }
          if (!current()) return;
          // spec/07 § A call can move between devices — the host closed this
          // session because the call was taken over elsewhere, or the agent hung
          // up. Neither is a failure: end the call here.
          if (reason === 'transferred' || reason === 'ended_by_agent') {
            void endVoiceCall();
            return;
          }
          line.lost(
            attempt,
            'connection_closed',
            error === null
              ? 'Call dropped — the audio connection closed'
              : `Call dropped — audio connection error: ${error}`,
          );
        },
      });
    } catch (e) {
      throw new VoiceAudioConnectError(
        `failed to open the call's audio session: ${(e as Error).message}`,
        e as Error,
      );
    }
    if (!current()) {
      call.close();
      return;
    }
    _call = call;
    _callAttempt = attempt;
    _callOpen = opened;
  } catch (e) {
    if (!current()) return;
    // Setup failed (token / permission / TTS-init / WS-open). A first dial
    // has failed and says why; a redial tries again (the line decides).
    console.log(`[patch-voice] call setup FAILED: ${(e as Error).message}`);
    line.lost(attempt, 'connection_closed', (e as Error).message);
  }
}

/**
 * A control frame from the host on `attempt`'s session. The heartbeat has
 * already been answered natively; here it feeds the line.
 */
function onHostFrame(line: CallLine, attempt: number, sessionId: string, text: string): void {
  let frame: AudioEvent;
  try {
    frame = decodeAudio(text);
  } catch (e) {
    useUiStore.getState().pushError(`voice call: malformed audio frame: ${(e as Error).message}`);
    return;
  }
  switch (frame.type) {
    case 'audio.heartbeat':
      line.heartbeat(attempt, frame);
      break;
    case 'audio.state':
      // Daemon-driven turn phase (spec/15 § Voice states) — drives the call
      // bar's LISTENING → TRANSCRIBING → THINKING → SPEAKING indicator. The
      // first one that is not `connecting` is the host acknowledging the
      // session: the line is live.
      console.log(`[patch-voice] call state → ${frame.state}`);
      if (frame.state !== 'connecting') {
        const wasLive = line.phase === 'live';
        line.acked(attempt, sessionId);
        // Live, or the agent started speaking: either way the quiet clock restarts.
        if (!wasLive || frame.state === 'speaking') heardSomething();
      }
      if (frame.state === 'transcribing') line.turn('speech_end');
      useVoiceStore.getState().setCallPhase(frame.state);
      break;
    case 'audio.transcript_partial':
      heardSomething();
      // Live interim STT — the call bar shows it as the trailing line of the
      // running transcript until the committed turn lands over the main WS.
      // The voice model streams faster than real time, so the host calls the
      // turn finished (tts_end → listening) while seconds of it are still
      // queued on the phone. The model then has nothing to interrupt and sends
      // no barge_in, so the user's words must stop the playback here. Not in
      // hands-free: speech there is not necessarily for Patch.
      if (
        useVoiceStore.getState().callPhase === 'listening' &&
        useVoiceStore.getState().callMode !== 'hands-free'
      ) {
        console.log('[patch-voice] call user speech over queued reply → flush playback');
        flushCallPlayback();
      }
      useVoiceStore.getState().setCallPhase('transcribing');
      useVoiceStore.getState().setCallTranscriptPartial(frame.text);
      break;
    case 'audio.transcript_final':
      heardSomething();
      // Final for this utterance; the committed user turn arrives as a normal
      // chat.message, so drop the interim line. The host has moved to
      // 'thinking' (it emits audio.state), but set it here too so the UI
      // advances even if that frame is reordered or lost.
      useVoiceStore.getState().setCallTranscriptPartial('');
      if (frame.addressed === false) {
        // Heard but not sent (spec/07 § Session modes): no turn is coming, so
        // the phase goes straight back to listening and the words are shown
        // greyed rather than vanishing as if the mic were dead.
        useVoiceStore.getState().setCallUnaddressed(frame.text);
        useVoiceStore.getState().setCallPhase('listening');
        break;
      }
      line.turn('transcript');
      useVoiceStore.getState().setCallUnaddressed(null);
      useVoiceStore.getState().setCallPhase('thinking');
      break;
    case 'audio.tts_end':
      heardSomething();
      // Speaking finished (or barge-in) → back to listening: the canonical
      // end-of-turn signal (the host emits no audio.state after tts_end).
      line.turn('reply_end');
      useVoiceStore.getState().setCallPhase('listening');
      break;
    case 'audio.barge_in':
      // The user spoke over the agent; the native session has already cut playback.
      useVoiceStore.getState().setCallPhase('listening');
      break;
    case 'audio.passed_to_agent':
      void playCallSound('passed-to-agent');
      break;
    case 'audio.chat_switched': {
      // The voice agent moved the call (spec/07 § A call stays on its chat):
      // the bar, the notification and any redial follow it.
      const st = useVoiceStore.getState();
      if (st.activeSession) {
        st.upgradeActive({ ...st.activeSession, chatId: frame.chatId });
        void updateVoiceAudioService(frame.chatId, serviceState()).catch(() => undefined);
      }
      break;
    }
    case 'audio.error': {
      // A failure the call carries on through (a catch-up, a voice tool): said, not fatal.
      if (AUDIO_NOTICE_CODES.has(frame.code)) {
        console.log(`[patch-voice] call notice ${frame.code}: ${frame.message}`);
        useUiStore.getState().pushError(`voice call: ${frame.message}`);
        break;
      }
      // LOUD + visible: the call bar names it. A hosted engine's failure names the engine.
      console.log(`[patch-voice] call audio.error ${frame.code}: ${frame.message}`);
      // The host went away under the call (it restarted, or the server lost
      // it): the line is lost, not failed (spec/07 § A dropped call comes back).
      if (frame.code === 'host_unreachable') {
        line.lost(attempt, 'host_unreachable', describeVoiceError(frame.code, frame.message));
        break;
      }
      // Every other error is one the host ends the call on.
      if (frame.code === 'mic_silent') {
        line.fail(attempt, frame.message);
        // Say what to do about it, once the permission is checked.
        void describeMicSilent(frame.message, {
          has: async () => (await Audio.getPermissionsAsync()).granted,
          ask: () => ensurePermission('microphone'),
        })
          .then((t) => useVoiceStore.getState().setError(t))
          .catch((e: unknown) =>
            useVoiceStore.getState().setError(`microphone check failed: ${String(e)}`),
          );
        break;
      }
      line.fail(attempt, describeVoiceError(frame.code, frame.message));
      break;
    }
    default:
      // session_* are not surface-actionable here.
      break;
  }
}

/** Mute (or unmute) the open session, keeping the notification in step. */
export function setCallMuted(muted: boolean): void {
  const store = useVoiceStore.getState();
  if (!store.activeSession) return;
  store.setMuted(muted);
  setDirectCallMuted(muted);
  void updateVoiceAudioService(store.activeSession.chatId, serviceState({ muted })).catch(
    () => undefined,
  );
}

/**
 * Flip the open session between its two modes (spec/07 § Session modes). One
 * session, two policies — nothing is torn down or reopened.
 */
export function setCallMode(next: AudioSessionMode): void {
  const store = useVoiceStore.getState();
  if (!store.activeSession) return;
  if (store.callMode === next) return;
  store.setCallMode(next);
  heardSomething();
  void updateVoiceAudioService(store.activeSession.chatId, serviceState({ mode: next })).catch(
    () => undefined,
  );
  const sessionId = store.activeSession.sessionId;
  if (sessionId === '') return;
  sendFrame({ type: 'audio.mode', sessionId, mode: next });
}

export async function endVoiceCall(): Promise<void> {
  // The line's log goes to the host while the socket is still open, then the
  // line stops: nothing it hears after this counts.
  const endingSessionId = _line?.sessionId ?? null;
  const endingChatId = useVoiceStore.getState().activeSession?.chatId;
  _line?.end();
  _line = null;
  clearQuietTimer();
  _transientFocus = false;
  // The call's end goes to its host through the server (spec/07 § Ending a
  // call), so it works with the audio socket down.
  if (endingSessionId !== null && endingChatId !== undefined) {
    callEnds.end(endingChatId, endingSessionId);
  }
  // A call hung up while failed has already said so with the failure sound.
  const endedState = useVoiceStore.getState();
  if (endedState.activeSession !== null && endedState.callError === null) {
    void playCallSound('ended');
  }
  closeCall();
  _serviceActions?.();
  _serviceActions = null;
  await endDirectCall();
  try {
    await stopVoiceAudioService();
  } catch (e) {
    // Said, not swallowed — but the call is over either way: a bar left up over
    // a closed socket cannot be retried, and a cross-engine mode switch that is
    // waiting on this would never start its new session.
    useUiStore
      .getState()
      .pushError(`voice call: audio service did not stop: ${(e as Error).message}`);
  } finally {
    useVoiceStore.getState().setActive(null);
  }
}

/**
 * Try a failed call again: tear down what is left of it and open a fresh
 * session on the same chat, in the same mode.
 */
export async function retryVoiceCall(): Promise<void> {
  const st = useVoiceStore.getState();
  const session = st.activeSession;
  if (!session) return;
  const mode = st.callMode;
  await endVoiceCall();
  startVoiceCall(session.chatId, mode);
}

/** The service's view of the call as it stands, with any field about to change. */
function serviceState(change: Partial<VoiceServiceState> = {}): VoiceServiceState {
  const st = useVoiceStore.getState();
  return {
    mode: st.callMode,
    muted: st.callMuted,
    paused: st.callPaused !== null,
    transientFocus: _transientFocus,
    ...change,
  };
}

/**
 * The notification's buttons, and the headphones coming and going, routed into
 * the same state the call bar drives so the two can never disagree.
 */
function onServiceAction(action: VoiceServiceAction): void {
  const store = useVoiceStore.getState();
  if (!store.activeSession) return;
  switch (action) {
    case 'stop':
      void endVoiceCall();
      return;
    case 'mute':
      setCallMuted(!store.callMuted);
      return;
    case 'mode':
      setCallMode(store.callMode === 'hands-free' ? 'call' : 'hands-free');
      return;
    case 'resume':
      resumeVoiceCall();
      return;
    case 'headset_removed':
      pauseVoiceCall('headphones');
      return;
    case 'headset_added':
      if (store.callPaused === 'headphones') resumeVoiceCall();
      return;
  }
}

/**
 * Pause the call (spec/07 § Pause): a soft hang-up. The voice session closes,
 * so nothing listens and nothing is billed, but the call stays in the chat and
 * the foreground service stays up — it is what lets headphones going back in
 * resume the call from the background. The service releases audio focus and
 * the headset route, so whatever else was playing can play again.
 */
export function pauseVoiceCall(reason: PauseReason = 'button'): void {
  const store = useVoiceStore.getState();
  const session = store.activeSession;
  if (session === null || store.callPaused !== null) return;
  // The line stops: its log goes to the host on the closing session, and the
  // socket and any setup still in flight are not this call's any more.
  _line?.end();
  _line = null;
  clearQuietTimer();
  sendFrame({
    type: 'audio.session_end',
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    reason: 'paused',
  });
  closeCall();
  void pauseDirectCall();
  store.setCallPaused(reason);
  store.setCallReconnecting(false);
  store.setCallTranscriptPartial('');
  store.setCallUnaddressed(null);
  store.setError(null);
  console.log(`[patch-voice] call paused (${reason})`);
  void playCallSound('paused');
  void updateVoiceAudioService(session.chatId, serviceState({ paused: true })).catch((e: Error) =>
    useUiStore.getState().pushError(`voice call: pause: ${e.message}`),
  );
}

/**
 * Resume a paused call: a new session on the same chat with a fresh start
 * context — not a redial, since nothing dropped. The connected cue plays when
 * the host answers.
 */
export function resumeVoiceCall(): void {
  const st = useVoiceStore.getState();
  const session = st.activeSession;
  if (session === null || st.callPaused === null) return;
  console.log('[patch-voice] call resuming');
  if (st.callDirect !== null) {
    st.setCallPaused(null);
    st.setCallPhase('connecting');
    void updateVoiceAudioService(session.chatId, serviceState({ paused: false })).catch(
      (e: Error) => useUiStore.getState().pushError(`voice call: resume: ${e.message}`),
    );
    void resumeDirectCall();
    return;
  }
  startVoiceCall(session.chatId, st.callMode, { resume: true });
}

/**
 * Start a direct call (spec/07 § Direct calls) with the same foreground service
 * and notification controls a voice agent call holds, so it keeps listening
 * with the phone in a pocket and the notification's buttons drive it.
 */
export function startDirectVoiceCall(chatId: string): Promise<void> {
  return startDirectCall(chatId, {
    holdAudio: async (id) => {
      await startVoiceAudioService(id, serviceState());
      _serviceActions?.();
      _serviceActions = onVoiceServiceAction(onServiceAction);
    },
    hangUp: endVoiceCall,
  });
}

/**
 * Pause when quiet for (Settings → Voice calls; spec/07 § Pause): a live call
 * in which nothing has been said by either side for that long pauses. Every
 * word heard or spoken restarts the clock. Hands-free is left alone: it is a
 * line left open on purpose and never ends itself on silence.
 */
// On the call's native clock: the phone is usually locked when the call goes quiet.
let _quietTimer: unknown = null;

function clearQuietTimer(): void {
  if (_quietTimer !== null) nativeCallClock.clearTimeout(_quietTimer);
  _quietTimer = null;
}

function heardSomething(): void {
  clearQuietTimer();
  const minutes = pauseWhenQuietMinutes();
  const st = useVoiceStore.getState();
  if (minutes === 0 || st.activeSession === null || st.callPaused !== null) return;
  if (st.callMode !== 'call') return;
  _quietTimer = nativeCallClock.setTimeout(() => {
    _quietTimer = null;
    // A reply still playing is not silence; look again once it has finished.
    if (useVoiceStore.getState().callPhase === 'speaking') {
      heardSomething();
      return;
    }
    pauseVoiceCall('quiet');
  }, minutes * 60_000);
}
