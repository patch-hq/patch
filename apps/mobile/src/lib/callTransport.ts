// A voice agent call's audio session, run by the native voice service
// (VoiceAudioService → CallTransport.kt), and the clock the call keeps time by.
//
// Everything that keeps a call alive runs on native threads: the socket, the
// microphone streaming up it, the answer to each host heartbeat and the playback
// of the reply (spec/07 § A call keeps going in the background). React Native
// throttles this JS and stops its timers once the app is in the background or
// the phone is locked, so none of that may wait on it. JS drives the session —
// open an attempt, send a control frame, close it — and hears what happens on
// it, to run the call's line and show the call.
//
// The clock is the same idea for the line's own timing (heartbeat watchdog,
// answer timeout, redial backoff, Pause when quiet): timers kept by the native
// service and fired as events, which JS still receives in the background.
//
// NO FALLBACK: without the native module there is no call on this phone, and
// opening one throws.

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { CallLineClock } from '@patch/wire/call-line';

interface PatchVoiceCallNative {
  callOpen(id: number, url: string, startFrame: string): Promise<void>;
  callSend(id: number, text: string): Promise<boolean>;
  callClose(id: number): Promise<void>;
  callFlush(): Promise<void>;
  setTimer(id: number, ms: number): void;
  clearTimer(id: number): void;
}

type CallEvent =
  | { kind: 'open'; id: number }
  | { kind: 'frame'; id: number; text: string }
  | { kind: 'reply_audio'; id: number; bytes: number }
  | { kind: 'closed'; id: number; code: number; reason: string; error?: string }
  | { kind: 'mic_error'; id: number; message: string }
  | {
      kind: 'audio_stopped';
      id: number;
      reason: 'audio_focus_taken' | 'output_device_changed';
      detail: string;
    };

/** What an open attempt tells its caller. Called only for the attempt it belongs to. */
export interface CallTransportHandlers {
  /** The socket opened and `audio.session_start` went; the microphone is opening. */
  onOpen(): void;
  /** A text frame from the host (heartbeats included: already echoed natively). */
  onFrame(text: string): void;
  /** A reply's first audio arrived and is playing. */
  onReplyAudio(bytes: number): void;
  /** The socket is gone; `error` set when it failed rather than closed. */
  onClose(close: { code: number; reason: string; error: string | null }): void;
  /** The microphone could not open, or failed mid-call. */
  onMicError(message: string): void;
  /** The phone's audio stopped without the line going (focus taken, a device came or went). */
  onAudioStopped(reason: 'audio_focus_taken' | 'output_device_changed', detail: string): void;
}

/** One attempt's session, as JS holds it. */
export interface CallTransport {
  /** Send a control frame; false when this attempt has no open socket. */
  send(frame: unknown): Promise<boolean>;
  /** Close the attempt (socket, microphone, playback). */
  close(): void;
}

function native(): PatchVoiceCallNative {
  if (Platform.OS !== 'android') {
    throw new Error(
      `a voice agent call runs on the Android voice service; ${Platform.OS} has none`,
    );
  }
  const mod = (NativeModules as Record<string, unknown>)['PatchVoiceAudioService'];
  if (!mod) {
    throw new Error(
      'PatchVoiceAudioService native module missing — is the package registered in MainApplication.kt?',
    );
  }
  return mod as PatchVoiceCallNative;
}

let _emitter: NativeEventEmitter | null = null;
function emitter(): NativeEventEmitter {
  _emitter ??= new NativeEventEmitter(
    (NativeModules as Record<string, unknown>)['PatchVoiceAudioService'] as never,
  );
  return _emitter;
}

const _attempts = new Map<number, CallTransportHandlers>();
let _nextId = 1;
let _listening = false;

function listen(): void {
  if (_listening) return;
  _listening = true;
  emitter().addListener('PatchVoiceCall', (ev: CallEvent) => {
    const h = _attempts.get(ev.id);
    if (h === undefined) return; // a closed attempt's late event
    switch (ev.kind) {
      case 'open':
        h.onOpen();
        return;
      case 'frame':
        h.onFrame(ev.text);
        return;
      case 'reply_audio':
        h.onReplyAudio(ev.bytes);
        return;
      case 'closed':
        _attempts.delete(ev.id);
        h.onClose({ code: ev.code, reason: ev.reason, error: ev.error ?? null });
        return;
      case 'mic_error':
        h.onMicError(ev.message);
        return;
      case 'audio_stopped':
        h.onAudioStopped(ev.reason, ev.detail);
        return;
    }
  });
}

/**
 * Dial `url` natively; `startFrame` is sent the moment the socket opens, then
 * the microphone streams. Rejects when the native side cannot start (no
 * playback device, a bad URL). Opening closes any attempt still open.
 */
export async function openCallTransport(
  url: string,
  startFrame: unknown,
  handlers: CallTransportHandlers,
): Promise<CallTransport> {
  const n = native();
  listen();
  const id = _nextId++;
  for (const old of _attempts.keys()) _attempts.delete(old);
  _attempts.set(id, handlers);
  try {
    await n.callOpen(id, url, JSON.stringify(startFrame));
  } catch (e) {
    _attempts.delete(id);
    throw e;
  }
  return {
    send: (frame) => n.callSend(id, JSON.stringify(frame)),
    close: () => {
      _attempts.delete(id);
      void n.callClose(id);
    },
  };
}

/** Drop the reply audio queued and playing (the user spoke over it). */
export function flushCallPlayback(): void {
  void native().callFlush();
}

const _timers = new Map<number, () => void>();
let _nextTimer = 1;
let _timerListening = false;

/**
 * The call's clock: timers kept on a native thread, so they fire with the app in
 * the background and the phone locked, where React Native's own do not.
 */
export const nativeCallClock: CallLineClock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const n = native();
    if (!_timerListening) {
      _timerListening = true;
      emitter().addListener('PatchVoiceTimer', (id: number) => {
        const f = _timers.get(id);
        if (f === undefined) return;
        _timers.delete(id);
        f();
      });
    }
    const id = _nextTimer++;
    _timers.set(id, fn);
    n.setTimer(id, ms);
    return id;
  },
  clearTimeout(handle) {
    const id = handle as number;
    if (!_timers.delete(id)) return;
    native().clearTimer(id);
  },
};
