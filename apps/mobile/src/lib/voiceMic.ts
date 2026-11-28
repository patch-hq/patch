// JS bridge to the PatchVoiceMic native module (Android AudioRecord PCM16 tap).
//
// Dictation, a voice note's live words and a direct call hear the microphone in
// JS (expo-av alone cannot stream PCM). This module bridges the native
// AudioRecord frames — emitted as base64 `PatchVoiceMicFrame` events — into
// per-frame PCM16. A voice agent call does not come through here: its
// microphone streams up its socket natively (callTransport.ts).
//
// NO FALLBACK: if the native module is missing on Android we throw — that means
// the prebuild didn't include PatchVoiceMicModule and the session would
// silently carry no audio. On non-Android (tests, dev web) we no-op.

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { useMicLevelStore } from '../stores/micLevelStore';

interface PatchVoiceMicModule {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  addListener: (event: string) => void;
  removeListeners: (count: number) => void;
}

interface MicFrameEvent {
  base64?: string;
  samples?: number;
  /** Set when the native read loop failed mid-stream (NO FALLBACK). */
  error?: string;
  /** Set when the phone's audio stopped under the capture: focus taken, a device came or went. */
  audioStopped?: 'audio_focus_taken' | 'output_device_changed';
  detail?: string;
}

const MODULE_NAME = 'PatchVoiceMic';
const EVENT = 'PatchVoiceMicFrame';

function getModule(): PatchVoiceMicModule | null {
  if (Platform.OS !== 'android') return null;
  const mod = (NativeModules as Record<string, unknown>)[MODULE_NAME];
  if (!mod) {
    throw new Error(
      'PatchVoiceMic native module missing — is PatchVoiceAudioServicePackage registered and the prebuild current?',
    );
  }
  return mod as PatchVoiceMicModule;
}

// Standard base64 → bytes. RN/Hermes has no atob, and pulling in a decoder dep
// for a hot audio path is overkill; this table decode is dependency-free and
// allocates one fresh (2-byte-aligned) buffer per frame.
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = ((): Int16Array => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i;
  return t;
})();

function decodeBase64(s: string): Uint8Array {
  let len = s.length;
  // The only caller guards `if (!ev.base64) return;` before decoding, so an
  // empty string never actually reaches here — kept as a defensive guard
  // against decodeBase64 being called directly in the future.
  /* v8 ignore next */
  if (len === 0) return new Uint8Array(0);
  let pad = 0;
  if (s.charCodeAt(len - 1) === 61) pad++; // '='
  if (s.charCodeAt(len - 2) === 61) pad++;
  const outLen = ((len * 3) >> 2) - pad;
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const a = B64_LOOKUP[s.charCodeAt(i)]!;
    const b = B64_LOOKUP[s.charCodeAt(i + 1)]!;
    const c = B64_LOOKUP[s.charCodeAt(i + 2)]!;
    const d = B64_LOOKUP[s.charCodeAt(i + 3)]!;
    const chunk = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
    if (o < outLen) out[o++] = (chunk >> 16) & 0xff;
    if (o < outLen) out[o++] = (chunk >> 8) & 0xff;
    if (o < outLen) out[o++] = chunk & 0xff;
  }
  return out;
}

let _sub: { remove: () => void } | null = null;
let _watchdog: ReturnType<typeof setTimeout> | null = null;

/** How long an opened microphone may stay silent of frames before it is reported dead. */
export const MIC_FIRST_FRAME_TIMEOUT_MS = 3000;

function clearWatchdog(): void {
  if (_watchdog !== null) clearTimeout(_watchdog);
  _watchdog = null;
}

// The native recorder is a single shared instance: `start` while it runs is a
// no-op and `stop` kills whatever is running. A stop still in flight from one
// dictation could therefore land after the next dictation's start, leaving the
// new session subscribed to a recorder that is already gone (green mic pill,
// zero frames). Every start and stop runs one at a time, in call order.
let _queue: Promise<unknown> = Promise.resolve();
function serial<T>(op: () => Promise<T>): Promise<T> {
  const run = _queue.then(op, op);
  _queue = run.catch(() => undefined);
  return run;
}

/**
 * Start capturing mic PCM16 @ 16 kHz. Each native frame is decoded to an
 * Int16Array (little-endian, matching the host's wire order) and handed to
 * `onFrame`. A mid-stream native failure, or a recorder that opens but never
 * delivers a frame, calls `onError` (the caller ends the call and surfaces it —
 * NO FALLBACK). Audio stopping under the capture without it failing — another
 * app taking the focus, a headset coming or going — goes to `onAudioStopped`,
 * for a call's log. No-op on non-Android.
 */
export function startMicCapture(
  onFrame: (pcm: Int16Array) => void,
  onError: (message: string) => void,
  onAudioStopped?: (reason: 'audio_focus_taken' | 'output_device_changed', detail: string) => void,
): Promise<void> {
  return serial(async () => {
    const m = getModule();
    if (!m) return;
    const emitter = new NativeEventEmitter(m as unknown as never);
    // A capture still holding the subscription would be orphaned by this one and
    // go on delivering frames to a caller that has moved on.
    _sub?.remove();
    clearWatchdog();
    const mine = emitter.addListener(EVENT, (ev: MicFrameEvent) => {
      if (ev.error) {
        onError(ev.error);
        return;
      }
      if (ev.audioStopped) {
        onAudioStopped?.(ev.audioStopped, ev.detail ?? '');
        return;
      }
      if (!ev.base64) return;
      if (_sub === mine) clearWatchdog();
      const bytes = decodeBase64(ev.base64);
      // `bytes` is a fresh 0-offset buffer, so this Int16Array view is 2-byte
      // aligned and spans the whole buffer — safe to forward as `.buffer`.
      const pcm = new Int16Array(bytes.buffer, 0, bytes.byteLength >>> 1);
      useMicLevelStore.getState().push(pcm);
      onFrame(pcm);
    });
    _sub = mine;
    try {
      await m.start();
    } catch (e) {
      // Nothing is capturing, so nobody will call stop: drop the subscription now
      // — this attempt's own, not a newer capture's that has replaced it since.
      mine.remove();
      if (_sub === mine) _sub = null;
      throw e;
    }
    _watchdog = setTimeout(() => {
      _watchdog = null;
      if (_sub === mine)
        onError(
          `the microphone opened but delivered no audio in ${MIC_FIRST_FRAME_TIMEOUT_MS / 1000}s`,
        );
    }, MIC_FIRST_FRAME_TIMEOUT_MS);
  });
}

/** Stop mic capture and drop the frame subscription. Idempotent. No-op on non-Android. */
export function stopMicCapture(): Promise<void> {
  // Detach synchronously so a frame arriving while the stop waits its turn
  // cannot reach a caller that has already moved on.
  _sub?.remove();
  _sub = null;
  clearWatchdog();
  useMicLevelStore.getState().reset();
  return serial(async () => {
    const m = getModule();
    if (!m) return;
    await m.stop();
  });
}
