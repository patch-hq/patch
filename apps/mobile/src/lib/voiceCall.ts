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
// MIC UPLINK (spec/07 § End-to-end voice transport — "Voice call (sustained)").
// The full inbound leg is wired and device-verifiable: token mint,
// mic-permission request, Android foreground service, opening the audio WSS, the
// `audio.session_start` control frame that binds the session, AND — the piece
// that made "nothing happens when I speak" true — streaming raw mic PCM16 up as
// interleaved `audio.pcm16` + binary frames. `expo-av` has no per-frame PCM tap
// (its Recording API only writes a whole file on stop), so capture is done by a
// custom native module (`PatchVoiceMic` → AudioRecord, src/lib/voiceMic.ts). The
// host VADs the frames, transcribes each utterance (Whisper) and commits it as
// a chat turn whose reply streams back into the timeline (spec/07 turn
// semantics). NO FALLBACK: if the native mic module is absent, or the read loop
// fails, the call is torn down and the error surfaced — never a live-looking
// call bar that carries no audio.
//
// OUTBOUND AUDIO (spec/07 § End-to-end voice transport — the down leg). Playing
// the agent's TTS reply out loud is done by a second native module: an
// AudioTrack streaming sink (`PatchVoiceTts` → src/lib/voiceTts.ts). The host
// streams Kokoro TTS as `audio.tts_chunk` PCM16 @ 24 kHz mono BINARY frames on
// the same WS; the `onmessage` handler below feeds each binary frame straight
// into the sink so the user HEARS the reply as it arrives. Barge-in
// (`audio.barge_in`) flushes the sink so cut-off audio stops immediately; the
// live STT `audio.transcript_partial` frames feed the call bar's running
// transcript. NO FALLBACK: if the sink can't init the call is torn down and the
// error surfaced — never a live-looking call bar that plays no audio back.
//
// VOICE ENGINE (spec/07 § Voice — a config matrix). Nothing in this file is
// specific to the `local` pipeline. `gemini` (Gemini Live) and `openai` (OpenAI
// Realtime) are relayed by the HOST: the phone opens the same audio WSS,
// sends the same `audio.session_start` and the same 16 kHz PCM up, and plays the
// same 24 kHz PCM back through the same long-lived AudioTrack sink, and the
// host runs whichever engine the account's voice config names for this
// session's mode. No provider key or ephemeral token ever reaches the phone,
// and no WebRTC module is needed. What the phone does with the config: it
// names a hosted engine on the call bar (`callEngineLabel`), it opens a fresh
// session when a mode switch crosses engines (`setCallMode`), and it names the
// engine when one fails (`describeVoiceError`) — a hosted engine's failure is
// never answered by running local instead.

import { playCallSound, syncCallSoundLoop } from './callSounds';
import { AppState } from 'react-native';
import { Audio } from 'expo-av';
import {
  decodeAudio,
  type AudioCallLogEvent,
  type AudioEvent,
  type AudioHeartbeatEvent,
  type AudioSessionMode,
} from '@patch/wire/audio';
import { CallLine, type CallLinePhase } from '@patch/wire/call-line';
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
import { startMicCapture, stopMicCapture } from './voiceMic';
import {
  endDirectCall,
  pauseDirectCall,
  resumeDirectCall,
  setDirectCallMuted,
  startDirectCall,
} from './directCall';
import { addressWordOrNull, pauseWhenQuietMinutes, voiceConfigOrNull } from './preferences';
import {
  callEngineLabel,
  describeMicSilent,
  describeVoiceError,
  modeSwitchNeedsNewSession,
} from './voiceEngine';
import { startTtsPlayback, writeTtsPcm, flushTtsPlayback, stopTtsPlayback } from './voiceTts';
import { ensurePermission } from './permissionGate';

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
let _ws: WebSocket | null = null;
/**
 * The call was answered on its own for an agent (Answer automatically in
 * hands-free): it holds transient audio focus, so the playback it paused
 * resumes when it ends. Kept for the call's life, across a pause.
 */
let _transientFocus = false;
/** The attempt `_ws` belongs to. */
let _wsAttempt = 0;
/** Unsubscribe for the notification-button listener, while a session is open. */
let _serviceActions: (() => void) | null = null;

// Coming back to the foreground is the moment Android allows the mic to start
// again: a waiting redial goes now rather than waiting out the backoff.
AppState.addEventListener('change', (state) => {
  if (state === 'active') _line?.foreground();
});

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

/** Close the socket of `attempt`, if it is still the open one. */
function closeAttempt(attempt: number): void {
  if (_wsAttempt !== attempt || _ws === null) return;
  const ws = _ws;
  _ws = null;
  ws.close();
}

function sendOn(attempt: number, frame: AudioHeartbeatEvent | AudioCallLogEvent): boolean {
  const ws = _ws;
  if (_wsAttempt !== attempt || ws === null || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch (e) {
    console.log(`[patch-voice] call ${frame.type} send failed: ${(e as Error).message}`);
    return false;
  }
}

/** Release every audio resource the call holds; keeps the store. */
async function releaseAudio(): Promise<void> {
  _ws?.close();
  _ws = null;
  _serviceActions?.();
  _serviceActions = null;
  await stopMicCapture().catch(() => undefined);
  await stopTtsPlayback().catch(() => undefined);
  await stopVoiceAudioService().catch(() => undefined);
}

function onLinePhase(next: CallLinePhase, prev: CallLinePhase, reason?: string): void {
  const st = useVoiceStore.getState();
  if (next === 'live') {
    st.setCallReconnecting(false);
    void playCallSound(prev === 'reconnecting' ? 'reconnected' : 'connected');
    return;
  }
  if (next === 'reconnecting') {
    // Nothing said while the line is down is kept: the dead attempt's mic and
    // playback stop here, and the redial starts both afresh.
    void stopMicCapture().catch(() => undefined);
    void stopTtsPlayback().catch(() => undefined);
    st.setCallReconnecting(true);
    st.setCallPhase('connecting');
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
  useVoiceStore.getState().setCallEngine(callEngineLabel(voiceConfigOrNull(), mode));
  // Diagnostic (logcat ReactNativeJS) — proves the tap handler fired and the
  // call bar mounted synchronously in CONNECTING state.
  console.log(`[patch-voice] startVoiceCall chatId=${chatId} bar=connecting`);
  // 2) The line dials, and redials whenever it drops.
  const line: CallLine = new CallLine({
    dial: (attempt, resumed) => {
      void openAttempt(line, chatId, attempt, {
        takeOver: opts.takeOver === true && attempt === 1,
        resumed,
        // Never repeated on a redial: the voice already opened with it.
        ...(opts.callReason !== undefined && !resumed ? { callReason: opts.callReason } : {}),
        // A paused call kept its service, and a redial never stopped it.
        serviceUp: opts.resume === true || resumed,
      });
    },
    hangUp: closeAttempt,
    send: sendOn,
    phase: onLinePhase,
    stillTrying: (reason) => {
      console.log(`[patch-voice] call redial still failing: ${reason}`);
      useUiStore.getState().pushError(`voice call: ${reason} — still trying`);
    },
  });
  _line = line;
  line.start();
}

/** Open one attempt's session: token, mic, playback, service, socket. */
async function openAttempt(
  line: CallLine,
  chatId: string,
  attempt: number,
  opts: { takeOver: boolean; resumed: boolean; callReason?: string; serviceUp: boolean },
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

    // Bring up the native AudioTrack sink BEFORE opening the WS so the first
    // `audio.tts_chunk` binary frame has somewhere to play. NO FALLBACK: a
    // failed init throws and the outer catch tears the attempt down.
    await startTtsPlayback();
    console.log('[patch-voice] call TTS AudioTrack sink started (PatchVoiceTts)');
    if (!current()) {
      await stopTtsPlayback().catch(() => undefined);
      return;
    }

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

    // Open the host audio WSS. The server returns a RELATIVE `/audio/<id>`
    // path; resolve it to an absolute ws(s):// URL against the audio plane
    // (same-origin via Caddy in prod; the direct host port in dev).
    const wsUrl = audioWsUrl(tok.audioUrl);
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      throw new VoiceAudioConnectError(
        `failed to open audio WS: ${(e as Error).message}`,
        e as Error,
      );
    }
    _ws = ws;
    _wsAttempt = attempt;
    // Receive TTS PCM as raw ArrayBuffers (not Blobs) so we can hand the
    // bytes straight to the native sink.
    ws.binaryType = 'arraybuffer';

    // Inbound frames: BINARY = TTS PCM16 @ 24 kHz → play; STRING = JSON
    // control frame. Mirrors the web surface's audioSession dispatch.
    // Count TTS binary chunks so the down leg's first-audio arrival is
    // pinpointable in logcat without spamming it per-chunk.
    let ttsChunks = 0;
    ws.onmessage = (evt: WebSocketMessageEvent): void => {
      const data = evt.data as unknown;
      if (typeof data !== 'string') {
        if (data instanceof ArrayBuffer) {
          // Guard odd byteLength — never assume 2-byte alignment on the wire.
          const usable = data.byteLength - (data.byteLength % 2);
          if (ttsChunks === 0) {
            console.log(
              `[patch-voice] call FIRST tts_chunk received (${data.byteLength}B) → AudioTrack`,
            );
          }
          ttsChunks++;
          line.turn('reply_audio');
          writeTtsPcm(usable === data.byteLength ? data : data.slice(0, usable));
        }
        return;
      }
      let frame: AudioEvent;
      try {
        frame = decodeAudio(data);
      } catch (e) {
        useUiStore
          .getState()
          .pushError(`voice call: malformed audio frame: ${(e as Error).message}`);
        return;
      }
      switch (frame.type) {
        case 'audio.heartbeat':
          line.heartbeat(attempt, frame);
          break;
        case 'audio.state':
          // Daemon-driven turn phase (spec/15 § Voice states) — drives the
          // call bar's LISTENING → TRANSCRIBING → THINKING → SPEAKING indicator.
          // The first one that is not `connecting` is the host acknowledging
          // the session: the line is live.
          console.log(`[patch-voice] call state → ${frame.state}`);
          if (frame.state !== 'connecting') {
            const wasLive = line.phase === 'live';
            line.acked(attempt, tok.sessionId);
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
          console.log(`[patch-voice] call transcript_partial: "${frame.text}"`);
          // The voice model streams faster than real time, so the host calls the
          // turn finished (tts_end → listening) while seconds of it are still
          // queued on the phone. The model then has nothing to interrupt and
          // sends no barge_in, so the user's words must stop the playback here.
          // Not in hands-free: speech there is not necessarily for Patch.
          if (
            useVoiceStore.getState().callPhase === 'listening' &&
            useVoiceStore.getState().callMode !== 'hands-free'
          ) {
            console.log('[patch-voice] call user speech over queued TTS → flush TTS sink');
            void flushTtsPlayback().catch(() => undefined);
          }
          useVoiceStore.getState().setCallPhase('transcribing');
          useVoiceStore.getState().setCallTranscriptPartial(frame.text);
          break;
        case 'audio.transcript_final':
          heardSomething();
          // Final for this utterance; the committed user turn arrives as a
          // normal chat.message, so drop the interim line. The host has moved
          // to 'thinking' (it emits audio.state), but set it here too so the UI
          // advances even if that frame is reordered/lost.
          console.log(`[patch-voice] call transcript_final: "${frame.text}"`);
          useVoiceStore.getState().setCallTranscriptPartial('');
          if (frame.addressed === false) {
            // Heard but not sent (spec/07 § Session modes): no turn is coming,
            // so the phase goes straight back to listening and the words are
            // shown greyed rather than vanishing as if the mic were dead.
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
          // Speaking finished (or barge-in) → back to listening. This is the
          // canonical end-of-turn signal; the host does NOT emit an
          // audio.state after tts_end (see session.ts speak() finally).
          console.log(
            `[patch-voice] call tts_end (bargedIn=${frame.bargedIn ?? false}) → listening`,
          );
          line.turn('reply_end');
          useVoiceStore.getState().setCallPhase('listening');
          break;
        case 'audio.barge_in':
          // User spoke over the agent — cut local playback immediately.
          console.log('[patch-voice] call barge_in → flush TTS sink');
          useVoiceStore.getState().setCallPhase('listening');
          void flushTtsPlayback().catch(() => undefined);
          break;
        case 'audio.error': {
          // LOUD + visible: the call bar names it. A hosted engine's failure
          // (`gemini_unavailable` / `openai_unavailable`) names the engine.
          console.log(`[patch-voice] call audio.error ${frame.code}: ${frame.message}`);
          // The host went away under the call (it restarted, or the server
          // lost it): the line is lost, not failed (spec/07 § A dropped call
          // comes back).
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
              .then((text) => useVoiceStore.getState().setError(text))
              .catch((e: unknown) =>
                useVoiceStore.getState().setError(`microphone check failed: ${String(e)}`),
              );
            break;
          }
          line.fail(attempt, describeVoiceError(frame.code, frame.message));
          break;
        }
        default:
          // tts_chunk / session_* are handled by the binary path or are not
          // surface-actionable here.
          break;
      }
    };

    // On open, send the `audio.session_start` control frame so the host
    // verifies the token and BINDS the session (spec/07, wire/audio).
    ws.onopen = (): void => {
      console.log(`[patch-voice] call audio WSS OPEN ${wsUrl}`);
      const start = {
        type: 'audio.session_start' as const,
        sessionId: tok.sessionId,
        accountId: me.account.accountId,
        surfaceId: me.surface.surfaceId,
        surfaceKind: 'mobile' as const,
        chatId,
        role: 'voice-call' as const,
        token: tok.token,
        // Android voice path uses hardware AEC; host bypasses its own.
        surfaceHasAec: true,
        mode: useVoiceStore.getState().callMode,
        ...(addressWord !== null ? { addressWord } : {}),
        ...(opts.takeOver ? { takeOver: true } : {}),
        ...(opts.resumed ? { resumed: true } : {}),
        ...(opts.callReason !== undefined ? { callReason: opts.callReason } : {}),
      };
      try {
        ws.send(JSON.stringify(start));
      } catch (e) {
        // Written off first, so the close it causes is not a second drop.
        line.lost(
          attempt,
          'connection_closed',
          `audio session_start failed: ${(e as Error).message}`,
        );
        closeAttempt(attempt);
        return;
      }
      console.log('[patch-voice] call session_start sent; starting mic capture (PatchVoiceMic)');

      // Stream mic PCM16 up as interleaved `audio.pcm16` + binary frames.
      // This is the leg whose absence made speaking do nothing: the host's
      // onMicFrame → VAD → Whisper → turn chain only runs once frames arrive.
      let frameCount = 0;
      void startMicCapture(
        (pcm: Int16Array): void => {
          // Bail if the attempt was replaced, the socket closed, or the user
          // muted — muting stops sending frames (the native mic keeps
          // running; we just don't forward, so the host hears silence).
          if (!current() || ws.readyState !== WebSocket.OPEN) return;
          if (useVoiceStore.getState().callMuted) return;
          try {
            ws.send(
              JSON.stringify({
                type: 'audio.pcm16',
                ts: Date.now(),
                sampleRate: 16000,
                samples: pcm.length,
              }),
            );
            ws.send(pcm.buffer as ArrayBuffer);
          } catch (e) {
            line.lost(
              attempt,
              'connection_closed',
              `mic frame send failed: ${(e as Error).message}`,
            );
            closeAttempt(attempt);
            return;
          }
          frameCount++;
          if (frameCount === 1) {
            console.log('[patch-voice] call FIRST mic frame sent up (mic uplink live)');
          } else if (frameCount % 50 === 0) {
            // ~2s cadence at 40ms frames — proves the uplink keeps flowing
            // without spamming logcat.
            console.log(`[patch-voice] call streamed ${frameCount} mic frames up`);
          }
        },
        (message: string): void => {
          // Native read loop failed mid-call. LOUD + visible in the call bar,
          // not just a toast — never a live-looking call that hears nothing.
          console.log(`[patch-voice] call mic read loop FAILED: ${message}`);
          line.fail(attempt, `mic failed: ${message}`);
        },
        (reason, detail): void => {
          // The phone's own audio stopped under a live line: log why.
          console.log(`[patch-voice] call audio stopped (${reason}): ${detail}`);
          line.audioStopped(reason, detail);
        },
      ).catch((e: unknown) => {
        // Missing native module / AudioRecord init failure.
        console.log(`[patch-voice] call mic capture START FAILED: ${(e as Error).message}`);
        line.fail(attempt, `mic unavailable: ${(e as Error).message}`);
      });
    };
    // An error always precedes its close; keep its detail for the close,
    // which is where the line hears that the attempt is gone.
    let wsErrorDetail: string | null = null;
    ws.onerror = (e: Event): void => {
      wsErrorDetail = `audio WS error: ${(e as Event).type ?? 'unknown'}`;
      console.log(`[patch-voice] call ${wsErrorDetail}`);
    };
    ws.onclose = (ev?: { reason?: string }): void => {
      if (_ws === ws) _ws = null;
      if (!current()) return;
      // Stop the mic AND the TTS sink so we don't keep capturing into — or
      // playing from — a dead socket.
      void stopMicCapture().catch(() => undefined);
      void stopTtsPlayback().catch(() => undefined);
      // spec/07 § A call can move between devices — the host closed this
      // session because the call was taken over elsewhere, or the agent hung
      // up. Neither is a failure: end the call here.
      if (ev?.reason === 'transferred' || ev?.reason === 'ended_by_agent') {
        void endVoiceCall();
        return;
      }
      line.lost(
        attempt,
        'connection_closed',
        wsErrorDetail === null
          ? 'Call dropped — the audio connection closed'
          : `Call dropped — ${wsErrorDetail}`,
      );
    };
  } catch (e) {
    if (!current()) return;
    // Setup failed (token / permission / TTS-init / WS-open). A first dial
    // has failed and says why; a redial tries again (the line decides).
    console.log(`[patch-voice] call setup FAILED: ${(e as Error).message}`);
    line.lost(attempt, 'connection_closed', (e as Error).message);
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
  // The two modes can be configured onto different engines (say, call on
  // Gemini Live, hands-free on local). One session runs one engine, so that
  // switch is a fresh session on the same chat — never the old engine carrying
  // on under the new mode's name.
  if (modeSwitchNeedsNewSession(voiceConfigOrNull(), store.callMode, next)) {
    const chatId = store.activeSession.chatId;
    console.log(`[patch-voice] mode ${store.callMode} → ${next} crosses engines: new session`);
    void endVoiceCall().then(() => startVoiceCall(chatId, next));
    return;
  }
  store.setCallMode(next);
  heardSomething();
  void updateVoiceAudioService(store.activeSession.chatId, serviceState({ mode: next })).catch(
    () => undefined,
  );
  const sessionId = store.activeSession.sessionId;
  if (_ws === null || _ws.readyState !== WebSocket.OPEN || sessionId === '') return;
  try {
    _ws.send(JSON.stringify({ type: 'audio.mode', sessionId, mode: next }));
  } catch (e) {
    useVoiceStore.getState().setError(`mode change failed: ${(e as Error).message}`);
  }
}

export async function endVoiceCall(): Promise<void> {
  // The line's log goes to the host while the socket is still open, then the
  // line stops: nothing it hears after this counts.
  _line?.end();
  _line = null;
  clearQuietTimer();
  _transientFocus = false;
  // A call hung up while failed has already said so with the failure sound.
  const endedState = useVoiceStore.getState();
  if (endedState.activeSession !== null && endedState.callError === null) {
    void playCallSound('ended');
  }
  const sessionId = useVoiceStore.getState().activeSession?.sessionId;
  try {
    _ws?.send(JSON.stringify({ type: 'audio.session_end', ...(sessionId ? { sessionId } : {}) }));
  } catch {
    // The WS may already be closed; closing below is the source of truth.
    // (This is bounded send-on-shutdown — not silently dropping a real error.)
  }
  _ws?.close();
  _ws = null;
  _serviceActions?.();
  _serviceActions = null;
  await endDirectCall();
  await stopMicCapture().catch(() => undefined);
  await stopTtsPlayback().catch(() => undefined);
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

export function audioWs(): WebSocket | null {
  return _ws;
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
  try {
    _ws?.send(
      JSON.stringify({
        type: 'audio.session_end',
        ...(session.sessionId ? { sessionId: session.sessionId } : {}),
        reason: 'paused',
      }),
    );
  } catch {
    // The socket may already be closed; closing below is the source of truth.
  }
  _ws?.close();
  _ws = null;
  void pauseDirectCall();
  void stopMicCapture().catch(() => undefined);
  void stopTtsPlayback().catch(() => undefined);
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
let _quietTimer: ReturnType<typeof setTimeout> | null = null;

function clearQuietTimer(): void {
  if (_quietTimer !== null) clearTimeout(_quietTimer);
  _quietTimer = null;
}

function heardSomething(): void {
  clearQuietTimer();
  const minutes = pauseWhenQuietMinutes();
  const st = useVoiceStore.getState();
  if (minutes === 0 || st.activeSession === null || st.callPaused !== null) return;
  if (st.callMode !== 'call') return;
  _quietTimer = setTimeout(() => {
    _quietTimer = null;
    // A reply still playing is not silence; look again once it has finished.
    if (useVoiceStore.getState().callPhase === 'speaking') {
      heardSomething();
      return;
    }
    pauseVoiceCall('quiet');
  }, minutes * 60_000);
}
