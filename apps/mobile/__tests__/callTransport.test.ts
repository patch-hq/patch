// lib/callTransport.ts — the JS side of a call's native session and clock
// (spec/07 § A call keeps going in the background). The Kotlin under it
// (CallTransport.kt) cannot run under Node; this pins the bridge: what it asks
// the native module to do, that each attempt hears only its own events, and
// that the call's clock is the native one.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Platform, NativeModules, NativeEventEmitter } from 'react-native';
import type { CallTransportHandlers } from '../src/lib/callTransport';

type Listener = (ev: unknown) => void;
// The module subscribes once, on first use, so capture its listeners for the file.
const listeners = new Map<string, Listener>();
const realAddListener = NativeEventEmitter.prototype.addListener;
NativeEventEmitter.prototype.addListener = function (event: string, cb: Listener) {
  listeners.set(event, cb);
  return realAddListener.call(this, event, cb);
};

function fire(event: string, payload: unknown): void {
  const cb = listeners.get(event);
  if (!cb) throw new Error(`nothing listening for ${event}`);
  cb(payload);
}

function handlers(): CallTransportHandlers & Record<string, ReturnType<typeof vi.fn>> {
  return {
    onOpen: vi.fn(),
    onFrame: vi.fn(),
    onReplyAudio: vi.fn(),
    onClose: vi.fn(),
    onMicError: vi.fn(),
    onAudioStopped: vi.fn(),
  };
}

let native: Record<string, ReturnType<typeof vi.fn>>;

/** The id the latest attempt was opened with. */
const lastId = (): number => native.callOpen!.mock.calls.at(-1)![0] as number;

beforeEach(() => {
  Platform.OS = 'android';
  native = {
    callOpen: vi.fn(async () => undefined),
    callSend: vi.fn(async () => true),
    callClose: vi.fn(async () => undefined),
    callFlush: vi.fn(async () => undefined),
    setTimer: vi.fn(),
    clearTimer: vi.fn(),
    addListener: vi.fn(),
    removeListeners: vi.fn(),
  };
  NativeModules['PatchVoiceAudioService'] = native;
});

afterEach(() => {
  delete NativeModules['PatchVoiceAudioService'];
});

describe('a call attempt', () => {
  it('dials natively with the session_start to send on open, and routes its events', async () => {
    const { openCallTransport } = await import('../src/lib/callTransport');
    const h = handlers();
    const call = await openCallTransport('ws://h/audio/s1', { type: 'audio.session_start' }, h);
    const id = lastId();
    expect(native.callOpen).toHaveBeenCalledWith(
      id,
      'ws://h/audio/s1',
      '{"type":"audio.session_start"}',
    );

    fire('PatchVoiceCall', { kind: 'open', id });
    fire('PatchVoiceCall', { kind: 'frame', id, text: '{"type":"audio.heartbeat"}' });
    fire('PatchVoiceCall', { kind: 'reply_audio', id, bytes: 9600 });
    fire('PatchVoiceCall', { kind: 'mic_error', id, message: 'read -3' });
    fire('PatchVoiceCall', {
      kind: 'audio_stopped',
      id,
      reason: 'audio_focus_taken',
      detail: 'AUDIOFOCUS_LOSS',
    });
    expect(h.onOpen).toHaveBeenCalledTimes(1);
    expect(h.onFrame).toHaveBeenCalledWith('{"type":"audio.heartbeat"}');
    expect(h.onReplyAudio).toHaveBeenCalledWith(9600);
    expect(h.onMicError).toHaveBeenCalledWith('read -3');
    expect(h.onAudioStopped).toHaveBeenCalledWith('audio_focus_taken', 'AUDIOFOCUS_LOSS');

    await call.send({ type: 'audio.mode', mode: 'hands-free' });
    expect(native.callSend).toHaveBeenCalledWith(id, '{"type":"audio.mode","mode":"hands-free"}');

    fire('PatchVoiceCall', { kind: 'closed', id, code: 1000, reason: 'transferred' });
    expect(h.onClose).toHaveBeenCalledWith({ code: 1000, reason: 'transferred', error: null });
  });

  it('a socket failure reaches the attempt with its error', async () => {
    const { openCallTransport } = await import('../src/lib/callTransport');
    const h = handlers();
    await openCallTransport('ws://h/a', {}, h);
    fire('PatchVoiceCall', {
      kind: 'closed',
      id: lastId(),
      code: 1006,
      reason: '',
      error: 'reset',
    });
    expect(h.onClose).toHaveBeenCalledWith({ code: 1006, reason: '', error: 'reset' });
  });

  it('an attempt that has been closed or replaced hears nothing more', async () => {
    const { openCallTransport } = await import('../src/lib/callTransport');
    const first = handlers();
    const call = await openCallTransport('ws://h/a', {}, first);
    const firstId = lastId();
    call.close();
    expect(native.callClose).toHaveBeenCalledWith(firstId);
    fire('PatchVoiceCall', { kind: 'closed', id: firstId, code: 1000, reason: '' });
    expect(first.onClose).not.toHaveBeenCalled();

    const second = handlers();
    await openCallTransport('ws://h/b', {}, second);
    const secondId = lastId();
    const third = handlers();
    await openCallTransport('ws://h/c', {}, third);
    fire('PatchVoiceCall', { kind: 'frame', id: secondId, text: 'late' });
    expect(second.onFrame).not.toHaveBeenCalled();
    fire('PatchVoiceCall', { kind: 'frame', id: lastId(), text: 'now' });
    expect(third.onFrame).toHaveBeenCalledWith('now');
  });

  it('a native session that cannot start rejects, and its id is forgotten', async () => {
    native.callOpen!.mockRejectedValueOnce(new Error('AudioTrack failed to initialise'));
    const { openCallTransport } = await import('../src/lib/callTransport');
    const h = handlers();
    await expect(openCallTransport('ws://h/a', {}, h)).rejects.toThrow(/AudioTrack/);
    fire('PatchVoiceCall', { kind: 'open', id: lastId() });
    expect(h.onOpen).not.toHaveBeenCalled();
  });

  it('flushing the reply goes to the native session', async () => {
    const { flushCallPlayback } = await import('../src/lib/callTransport');
    flushCallPlayback();
    expect(native.callFlush).toHaveBeenCalled();
  });

  it('there is no call without the native module (NO FALLBACK)', async () => {
    delete NativeModules['PatchVoiceAudioService'];
    const { openCallTransport } = await import('../src/lib/callTransport');
    await expect(openCallTransport('ws://h/a', {}, handlers())).rejects.toThrow(
      /native module missing/,
    );
    Platform.OS = 'ios';
    await expect(openCallTransport('ws://h/a', {}, handlers())).rejects.toThrow(
      /runs on the Android voice service/,
    );
  });
});

describe('the call clock', () => {
  it('keeps its timers natively and fires them from the native event', async () => {
    const { nativeCallClock } = await import('../src/lib/callTransport');
    const fn = vi.fn();
    const handle = nativeCallClock.setTimeout(fn, 3000);
    expect(native.setTimer).toHaveBeenCalledWith(handle, 3000);
    fire('PatchVoiceTimer', handle);
    expect(fn).toHaveBeenCalledTimes(1);
    // A timer fires once.
    fire('PatchVoiceTimer', handle);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a cleared timer is cleared natively and never fires', async () => {
    const { nativeCallClock } = await import('../src/lib/callTransport');
    const fn = vi.fn();
    const handle = nativeCallClock.setTimeout(fn, 1000);
    nativeCallClock.clearTimeout(handle);
    expect(native.clearTimer).toHaveBeenCalledWith(handle);
    fire('PatchVoiceTimer', handle);
    expect(fn).not.toHaveBeenCalled();
    // Clearing one that already fired or was cleared asks nothing of the native side.
    native.clearTimer!.mockClear();
    nativeCallClock.clearTimeout(handle);
    expect(native.clearTimer).not.toHaveBeenCalled();
  });
});
