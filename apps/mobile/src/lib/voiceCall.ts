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
import { decodeAudio, type AudioEvent, type AudioSessionMode } from '@patch/wire/audio';
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

let _ws: WebSocket | null = null;
/**
 * The call was answered on its own for an agent (Answer automatically in
 * hands-free): it holds transient audio focus, so the playback it paused
 * resumes when it ends. Kept for the call's life, across a pause.
 */
let _transientFocus = false;
/** Unsubscribe for the notification-button listener, while a session is open. */
let _serviceActions: (() => void) | null = null;
// Bumped each time a call starts; lets a stale async setup detect that the
// user already ended the call (or started a new one) and bail.
let _callGen = 0;
/** Fires if the session never reaches the host (see CALL_CONNECT_TIMEOUT_MS). */
let _connectTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * How long a call may sit in `connecting` before it is declared failed. A
 * session that never gets the host's first `audio.state` has no working
 * audio path; leaving it "Connecting…" forever is a silent failure, so it is
 * torn down and says so, with a retry (spec/15 § Voice states).
 */
export const CALL_CONNECT_TIMEOUT_MS = 15_000;

/**
 * A call that drops after it was live (server restart, host restart, network
 * change) is redialled by itself on this backoff, about two minutes in all:
 * long enough to ride out a release restarting the server and the host. After the last attempt fails the
 * red "Call problem" banner and Retry appear, naming the last failure.
 */
export const CALL_RECONNECT_DELAYS_MS = [
  1_000, 2_000, 4_000, 8_000, 15_000, 20_000, 30_000, 30_000,
];

let _reconnect: { attempt: number; chatId: string; mode: AudioSessionMode } | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function clearReconnect(): void {
  if (_reconnectTimer !== null) clearTimeout(_reconnectTimer);
  _reconnectTimer = null;
  _reconnect = null;
}

/**
 * The line dropped (or a redial failed): redial after a delay. A call never
 * gives up by itself — an interruption can outlast any fixed budget, and
 * Android may refuse to restart the mic until the phone wakes — so after the
 * schedule it keeps trying at the last delay until the user ends the call. The
 * failure is said once, loudly, when the schedule runs out.
 */
function reconnectOrGiveUp(chatId: string, mode: AudioSessionMode, reason: string): void {
  const attempt = _reconnect?.attempt ?? 0;
  const delay = CALL_RECONNECT_DELAYS_MS[Math.min(attempt, CALL_RECONNECT_DELAYS_MS.length - 1)];
  const st = useVoiceStore.getState();
  if (attempt === CALL_RECONNECT_DELAYS_MS.length) {
    console.log(`[patch-voice] call redial still failing after ${attempt} attempts: ${reason}`);
    useUiStore.getState().pushError(`voice call: ${reason} — still trying`);
  }
  console.log(`[patch-voice] call dropped (${reason}) → redial ${attempt + 1} in ${delay}ms`);
  _reconnect = { attempt: attempt + 1, chatId, mode };
  // Phase first: clearing the error (or any other change) while the phase
  // still reads live would look to the subscription above like a redial that
  // had come up.
  st.setCallPhase('connecting');
  st.setCallReconnecting(true);
  st.setError(null);
  const gen = _callGen;
  if (_reconnectTimer !== null) clearTimeout(_reconnectTimer);
  _reconnectTimer = setTimeout(redialNow, delay);
  _redialGen = gen;
}

let _redialGen = 0;

function redialNow(): void {
  if (_reconnect === null || _reconnectTimer === null) return;
  clearTimeout(_reconnectTimer);
  _reconnectTimer = null;
  if (_redialGen !== _callGen) return; // the user ended the call while we waited
  startVoiceCall(_reconnect.chatId, _reconnect.mode, { reconnect: true });
}

// Coming back to the foreground is the moment Android allows the mic to start
// again: redial now rather than wait out the backoff.
AppState.addEventListener('change', (state) => {
  if (state === 'active') redialNow();
});

// A redial that fails (token mint, connect timeout, immediate close) sets
// callError; while redialling that means try again. One that gets the host's
// first state is live, so the attempt count resets.
useVoiceStore.subscribe((s) => {
  if (_reconnect === null || s.activeSession === null) return;
  if (s.callError !== null) {
    reconnectOrGiveUp(_reconnect.chatId, _reconnect.mode, s.callError);
  } else if (s.callPhase !== 'connecting') {
    clearReconnect();
  }
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
  // An agent's call rings over a paused call (spec/07 § Pause), never over a live one.
  syncCallSoundLoop(
    'agent-calling',
    s.incomingCall !== null && (s.activeSession === null || s.callPaused !== null),
  );
});

// A call that has failed for good says so aloud. A redial clears its error
// within the same update, so it is read from the store now, not from the
// notification, and an error that stays is cued once.
let _errorCued = false;
useVoiceStore.subscribe(() => {
  const s = useVoiceStore.getState();
  if (s.activeSession === null || s.callError === null) {
    _errorCued = false;
    return;
  }
  if (_errorCued) return;
  _errorCued = true;
  void playCallSound('failed');
});

function clearConnectTimer(): void {
  if (_connectTimer !== null) clearTimeout(_connectTimer);
  _connectTimer = null;
}

/** Release every audio resource the setup may have taken; keeps the store. */
async function releaseAudio(): Promise<void> {
  _ws?.close();
  _ws = null;
  _serviceActions?.();
  _serviceActions = null;
  await stopMicCapture().catch(() => undefined);
  await stopTtsPlayback().catch(() => undefined);
  await stopVoiceAudioService().catch(() => undefined);
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
    reconnect?: boolean;
    /** Why the agent rang, on a call answering its `patch_call`: the voice opens with it. */
    callReason?: string;
    /** Answered on its own for an agent: take transient audio focus (see `_transientFocus`). */
    transientFocus?: boolean;
    /** Resuming this paused call: same call, so the same timer and the service already up. */
    resume?: boolean;
  } = {},
): void {
  if (opts.reconnect !== true) clearReconnect();
  clearQuietTimer();
  // A new call (not this one coming back) sets how it holds focus.
  if (opts.reconnect !== true && opts.resume !== true)
    _transientFocus = opts.transientFocus === true;
  // A paused call kept its foreground service: resuming updates it, not starts it.
  const serviceUp = opts.resume === true;
  // 1) Mount the call bar synchronously — CONNECTING state, empty session. A
  // redial is the same call: it keeps its start, its timer and its mute. A
  // resume keeps its start, and connects afresh (the connected sound plays).
  const gen = ++_callGen;
  useVoiceStore.getState().setActive(
    {
      sessionId: '',
      chatId,
      audioUrl: '',
      startedAt:
        (opts.reconnect === true || opts.resume === true
          ? useVoiceStore.getState().activeSession?.startedAt
          : undefined) ?? Date.now(),
    },
    { redial: opts.reconnect === true },
  );
  useVoiceStore.getState().setCallMode(mode);
  useVoiceStore.getState().setCallAddressWord(addressWordOrNull());
  useVoiceStore.getState().setCallEngine(callEngineLabel(voiceConfigOrNull(), mode));
  // Connect watchdog: the host's first `audio.state` (sent on session_start)
  // is what moves the phase off `connecting`. No answer in time = failed.
  clearConnectTimer();
  _connectTimer = setTimeout(() => {
    _connectTimer = null;
    const st = useVoiceStore.getState();
    if (gen !== _callGen || st.callPhase !== 'connecting' || st.callError !== null) return;
    const secs = Math.round(CALL_CONNECT_TIMEOUT_MS / 1000);
    console.log(`[patch-voice] call connect TIMED OUT after ${secs}s`);
    st.setError(`Could not connect — no answer from the host after ${secs}s`);
    useUiStore.getState().pushError(`voice call: no answer from the host after ${secs}s`);
    // The setup may still be waiting on the token or the mic permission: end
    // this attempt, so it stops where it is instead of waking up later and
    // opening a live call under a bar that says it failed.
    _callGen++;
    void releaseAudio();
  }, CALL_CONNECT_TIMEOUT_MS);
  // Diagnostic (logcat ReactNativeJS) — proves the tap handler fired and the
  // call bar mounted synchronously in CONNECTING state.
  console.log(`[patch-voice] startVoiceCall chatId=${chatId} bar=connecting`);

  // 2) Open the real session in the background.
  void (async () => {
    try {
      // Identity is required in the host session_start frame; mint a
      // one-shot token bound to (this surface, chatId) for a sustained call.
      const addressWord = addressWordOrNull();
      const me = await api.me();
      const tok = await api.voiceToken(chatId, 'voice-call');
      if (gen !== _callGen) return; // user ended/replaced the call during mint
      if (!tok.audioUrl) {
        throw new Error('server returned empty audioUrl');
      }
      console.log(
        `[patch-voice] call token minted sessionId=${tok.sessionId} audioUrl=${tok.audioUrl}`,
      );
      if (!(await ensurePermission('microphone'))) {
        throw new Error('mic permission denied');
      }
      if (gen !== _callGen) return;
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
      if (gen !== _callGen) return;

      // Bring up the native AudioTrack sink BEFORE opening the WS so the first
      // `audio.tts_chunk` binary frame has somewhere to play. NO FALLBACK: a
      // failed init throws and the outer catch tears the call down.
      await startTtsPlayback();
      console.log('[patch-voice] call TTS AudioTrack sink started (PatchVoiceTts)');
      if (gen !== _callGen) {
        await stopTtsPlayback().catch(() => undefined);
        return;
      }

      // Upgrade the call bar to the live session (real id + audio URL). The
      // timer keeps running off the original startedAt.
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
      const serviceState = {
        mode: useVoiceStore.getState().callMode,
        muted: useVoiceStore.getState().callMuted,
        transientFocus: _transientFocus,
      };
      await (serviceUp
        ? updateVoiceAudioService(chatId, { ...serviceState, paused: false })
        : startVoiceAudioService(chatId, serviceState));
      // The notification's own buttons are the control surface for a phone in a
      // pocket (spec/15 § Voice tab). Route them into the same state the
      // call bar drives, so the two can never disagree about what the session is
      // doing.
      _serviceActions?.();
      _serviceActions = onVoiceServiceAction(onServiceAction);
      if (gen !== _callGen) {
        // Paused while the service came up: the call goes on, and its service and
        // listener are what headphones going back in will resume it through.
        if (useVoiceStore.getState().callPaused !== null) return;
        // Superseded while the service came up: the listener taken just above
        // is this attempt's own (nothing awaited since), and nobody else will
        // ever release it.
        _serviceActions?.();
        _serviceActions = null;
        await stopVoiceAudioService().catch(() => undefined);
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
      // Receive TTS PCM as raw ArrayBuffers (not Blobs) so we can hand the
      // bytes straight to the native sink.
      ws.binaryType = 'arraybuffer';

      // Inbound frames: BINARY = TTS PCM16 @ 24 kHz → play; STRING = JSON
      // control frame (transcript / barge-in / tts_end / error). Mirrors the
      // web surface's audioSession dispatch.
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
          case 'audio.state':
            // Daemon-driven turn phase (spec/15 § Voice states) — drives the
            // call bar's LISTENING → TRANSCRIBING → THINKING → SPEAKING indicator.
            console.log(`[patch-voice] call state → ${frame.state}`);
            if (frame.state !== 'connecting') clearConnectTimer();
            if (frame.state !== 'connecting') {
              const st = useVoiceStore.getState();
              const wasLive = st.callConnectedAt !== null;
              const wasReconnecting = st.callReconnectingSince !== null;
              st.setCallReconnecting(false);
              st.setCallPhase(frame.state);
              if (wasReconnecting) void playCallSound('reconnected');
              else if (!wasLive) void playCallSound('connected');
              // Live, or the agent started speaking: either way the quiet clock restarts.
              if (frame.state === 'speaking' || !wasLive || wasReconnecting) heardSomething();
            } else {
              useVoiceStore.getState().setCallPhase(frame.state);
            }
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
            useVoiceStore.getState().setCallPhase('listening');
            break;
          case 'audio.barge_in':
            // User spoke over the agent — cut local playback immediately.
            console.log('[patch-voice] call barge_in → flush TTS sink');
            useVoiceStore.getState().setCallPhase('listening');
            void flushTtsPlayback().catch(() => undefined);
            break;
          case 'audio.error': {
            // LOUD + visible: show it in the call bar (setError), not just a
            // toast. A hosted engine's failure (`gemini_unavailable` /
            // `openai_unavailable`) names the engine; the host ends the
            // session behind a fatal one, and the close handler below finds
            // this reason already on screen.
            console.log(`[patch-voice] call audio.error ${frame.code}: ${frame.message}`);
            clearConnectTimer();
            const show = (text: string): void => {
              useVoiceStore.getState().setError(text);
              useUiStore.getState().pushError(`voice call: ${text}`);
            };
            if (frame.code === 'mic_silent') {
              void describeMicSilent(frame.message, {
                has: async () => (await Audio.getPermissionsAsync()).granted,
                ask: () => ensurePermission('microphone'),
              })
                .then(show)
                .catch((e: unknown) => show(`microphone check failed: ${String(e)}`));
              break;
            }
            // The host went away under a live call (it restarted, or the server
            // lost it): redial rather than end the call (spec/07 § A dropped call
            // comes back). Only a call that was up, or is itself a redial.
            if (
              frame.code === 'host_unreachable' &&
              (_reconnect !== null || useVoiceStore.getState().callPhase !== 'connecting')
            ) {
              reconnectOrGiveUp(
                chatId,
                useVoiceStore.getState().callMode,
                describeVoiceError(frame.code, frame.message),
              );
              break;
            }
            show(describeVoiceError(frame.code, frame.message));
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
          ...(opts.takeOver === true ? { takeOver: true } : {}),
          ...(opts.reconnect === true ? { resumed: true } : {}),
          ...(opts.callReason !== undefined && opts.reconnect !== true
            ? { callReason: opts.callReason }
            : {}),
        };
        try {
          ws.send(JSON.stringify(start));
        } catch (e) {
          useVoiceStore.getState().setError(`audio session_start failed: ${(e as Error).message}`);
          return;
        }
        console.log('[patch-voice] call session_start sent; starting mic capture (PatchVoiceMic)');

        // Stream mic PCM16 up as interleaved `audio.pcm16` + binary frames.
        // This is the leg whose absence made speaking do nothing: the host's
        // onMicFrame → VAD → Whisper → turn chain only runs once frames arrive.
        let frameCount = 0;
        void startMicCapture(
          (pcm: Int16Array): void => {
            // Bail if the call was ended/replaced, the socket closed, or the
            // user muted — muting stops sending frames (the native mic keeps
            // running; we just don't forward, so the host hears silence).
            if (gen !== _callGen || ws.readyState !== WebSocket.OPEN) return;
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
              useVoiceStore.getState().setError(`mic frame send failed: ${(e as Error).message}`);
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
            // Native read loop failed mid-call. LOUD + visible in the call bar
            // (setError), not just a toast — the user keeps the call bar with the
            // error and ends the dead call themselves (NO silent live-looking call).
            console.log(`[patch-voice] call mic read loop FAILED: ${message}`);
            useVoiceStore.getState().setError(`mic failed: ${message}`);
            useUiStore.getState().pushError(`voice call mic: ${message}`);
          },
        ).catch((e: unknown) => {
          // Missing native module / AudioRecord init failure. LOUD + visible in
          // the call bar so the user SEES why the call is silent (a toast alone is
          // easy to miss). The call bar stays up with the error + End button.
          console.log(`[patch-voice] call mic capture START FAILED: ${(e as Error).message}`);
          useVoiceStore.getState().setError(`mic unavailable: ${(e as Error).message}`);
          useUiStore
            .getState()
            .pushError(`voice call: mic capture failed: ${(e as Error).message}`);
        });
      };
      // An error always precedes its close. Setting callError here would make
      // onclose think the failure was already reported and skip the redial, so
      // a live call would end on the first socket error. Keep the detail and
      // let onclose (the single decision point) redial or give up with it.
      let wsErrorDetail: string | null = null;
      ws.onerror = (e: Event): void => {
        wsErrorDetail = `audio WS error: ${(e as Event).type ?? 'unknown'}`;
        console.log(`[patch-voice] call ${wsErrorDetail}`);
      };
      // If the host (or network) drops the session, stop the mic AND the TTS
      // sink so we don't keep capturing into — or playing from — a dead socket.
      ws.onclose = (ev?: { reason?: string }): void => {
        void stopMicCapture().catch(() => undefined);
        void stopTtsPlayback().catch(() => undefined);
        // A close the user did not ask for (endVoiceCall bumps the generation
        // first) is a dropped call — say so rather than leave a bar that
        // still reads "Listening" over a dead socket.
        if (gen !== _callGen) return;
        clearConnectTimer();
        // spec/07 § A call can move between devices — the host closed this
        // session because the call was taken over elsewhere. That is not a
        // failure: end the call here and let the remote-call pill say where it is.
        if (ev?.reason === 'transferred' || ev?.reason === 'ended_by_agent') {
          void endVoiceCall();
          return;
        }
        // A redial is already booked (the host-unreachable error above got here
        // first): this close is the same drop, not a second one.
        if (_reconnectTimer !== null) return;
        const st = useVoiceStore.getState();
        if (st.activeSession && st.callError === null) {
          const reason =
            wsErrorDetail === null
              ? 'Call dropped — the audio connection closed'
              : `Call dropped — ${wsErrorDetail}`;
          // Redial if the call had been live, or if this was itself a redial.
          if (_reconnect !== null || st.callPhase !== 'connecting') {
            reconnectOrGiveUp(chatId, st.callMode, reason);
          } else {
            st.setError(reason);
          }
        }
      };
    } catch (e) {
      if (gen !== _callGen) return;
      // Setup failed (token / permission / TTS-init / WS-open). LOUD + visible:
      // tear down the audio resources but KEEP the call bar mounted showing the
      // error + End button (setError), so the user SEES why the call is dead
      // instead of the call bar silently vanishing behind a toast. NO FALLBACK.
      console.log(`[patch-voice] call setup FAILED: ${(e as Error).message}`);
      clearConnectTimer();
      // Error first: releasing closes the socket, and its onclose must find
      // the real reason already on screen rather than a generic "dropped".
      useVoiceStore.getState().setError((e as Error).message);
      useUiStore.getState().pushError(`voice call: ${(e as Error).message}`);
      await releaseAudio();
    }
  })();
}

/** Mute (or unmute) the open session, keeping the notification in step. */
export function setCallMuted(muted: boolean): void {
  const store = useVoiceStore.getState();
  if (!store.activeSession) return;
  store.setMuted(muted);
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
  // Invalidate any in-flight setup so it tears itself down.
  _callGen++;
  // A call hung up while failed has already said so with the error cue.
  const endedState = useVoiceStore.getState();
  if (endedState.activeSession !== null && endedState.callError === null) {
    void playCallSound('ended');
  }
  clearConnectTimer();
  clearReconnect();
  clearQuietTimer();
  _transientFocus = false;
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
  // The closing session's socket and any setup still in flight are not this call's any more.
  _callGen++;
  clearConnectTimer();
  clearReconnect();
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
  startVoiceCall(session.chatId, st.callMode, { resume: true });
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
