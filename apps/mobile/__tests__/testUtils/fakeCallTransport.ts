// A controllable stand-in for the native call session (src/lib/callTransport.ts
// → CallTransport.kt), for testing src/lib/voiceCall.ts. Each opened attempt
// is recorded so a test can drive what the native side would report (open, a
// host frame, reply audio, close) and read what was sent on it. Like the native
// side, `sent` starts with the session_start frame once the socket opens.
//
// Install with `vi.mock('../src/lib/callTransport', () => fakeCallTransportModule())`.
import { vi } from 'vitest';
import type { CallLineClock } from '@patch/wire/call-line';
import type { CallTransportHandlers } from '../../src/lib/callTransport';

export class FakeCallTransport {
  static instances: FakeCallTransport[] = [];
  /** Most recently opened attempt, or throws if none. */
  static last(): FakeCallTransport {
    const i = FakeCallTransport.instances.at(-1);
    if (!i) throw new Error('FakeCallTransport: no attempt opened yet');
    return i;
  }
  static reset(): void {
    FakeCallTransport.instances = [];
  }

  /** Whether the socket is open (after emitOpen, until close). */
  open = false;
  closed = false;
  /** Frames sent: session_start (on open) then control frames, as JSON strings. */
  sent: string[] = [];
  send = vi.fn(async (frame: unknown): Promise<boolean> => {
    if (!this.open || this.closed) return false;
    this.sent.push(JSON.stringify(frame));
    return true;
  });
  close = vi.fn((): void => {
    this.closed = true;
    this.open = false;
  });

  constructor(
    readonly url: string,
    readonly startFrame: unknown,
    readonly handlers: CallTransportHandlers,
  ) {
    FakeCallTransport.instances.push(this);
  }

  /** The native socket opened: session_start went first. */
  emitOpen(): void {
    this.open = true;
    this.sent.push(JSON.stringify(this.startFrame));
    this.handlers.onOpen();
  }
  /** A text frame from the host (an object is encoded). */
  emitMessage(frame: unknown): void {
    this.handlers.onFrame(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }
  emitReplyAudio(bytes = 4800): void {
    this.handlers.onReplyAudio(bytes);
  }
  emitClose(code = 1000, reason = '', error: string | null = null): void {
    this.open = false;
    this.closed = true;
    this.handlers.onClose({ code, reason, error });
  }
  emitMicError(message: string): void {
    this.handlers.onMicError(message);
  }
  emitAudioStopped(reason: 'audio_focus_taken' | 'output_device_changed', detail: string): void {
    this.handlers.onAudioStopped(reason, detail);
  }
}

export const openCallTransportMock = vi.fn(
  async (url: string, startFrame: unknown, handlers: CallTransportHandlers) => {
    const t = new FakeCallTransport(url, startFrame, handlers);
    return { send: t.send, close: t.close };
  },
);
export const flushCallPlaybackMock = vi.fn();

/** The test's clock is the JS one, so vi.useFakeTimers() drives it. */
export const fakeCallClock: CallLineClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function fakeCallTransportModule(): Record<string, unknown> {
  return {
    openCallTransport: openCallTransportMock,
    flushCallPlayback: flushCallPlaybackMock,
    nativeCallClock: fakeCallClock,
  };
}
