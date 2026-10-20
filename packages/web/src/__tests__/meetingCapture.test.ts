import { describe, expect, it, vi } from 'vitest';
import {
  ClipBuilder,
  MIN_TAIL_SECONDS,
  SILENCE_RMS,
  bytesToBase64,
  pcm16ToWav,
  rmsOfPcm16,
  startMeetingCapture,
} from '../lib/meetingCapture.js';

const loud = (n: number): Int16Array => new Int16Array(n).fill(8000);

describe('pcm16ToWav', () => {
  it('writes a 16 kHz mono PCM16 header', () => {
    const wav = pcm16ToWav(loud(100));
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE');
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(40, true)).toBe(200);
    expect(wav.length).toBe(244);
  });
});

describe('bytesToBase64', () => {
  it('round-trips large buffers', () => {
    const b = new Uint8Array(100_000).map((_, i) => i % 251);
    expect(Uint8Array.from(atob(bytesToBase64(b)), (c) => c.charCodeAt(0))).toEqual(b);
  });
});

describe('ClipBuilder', () => {
  it('cuts a clip each time the clip length is full', () => {
    const clips: Uint8Array[] = [];
    const b = new ClipBuilder((w) => clips.push(w), 2);
    for (let i = 0; i < 5; i++) b.push(loud(16000)); // 5 s
    expect(clips).toHaveLength(2);
    expect(clips[0]!.length).toBe(44 + 2 * 16000 * 2);
  });

  it('drops a silent clip instead of sending it to Whisper', () => {
    const clips: Uint8Array[] = [];
    const b = new ClipBuilder((w) => clips.push(w), 1);
    b.push(new Int16Array(16000));
    expect(clips).toHaveLength(0);
    expect(rmsOfPcm16(new Int16Array(10))).toBeLessThan(SILENCE_RMS);
  });

  it('setClipSeconds shortens the clip from now on, flushing a buffer already long enough', () => {
    const clips: Uint8Array[] = [];
    const b = new ClipBuilder((w) => clips.push(w), 15);
    b.push(loud(16000 * 4));
    expect(clips).toHaveLength(0);
    b.setClipSeconds(3);
    expect(clips).toHaveLength(1);
    b.push(loud(16000 * 3));
    expect(clips).toHaveLength(2);
  });

  it('flush sends a worthwhile tail and discards a trivial one', () => {
    const clips: Uint8Array[] = [];
    const b = new ClipBuilder((w) => clips.push(w), 15);
    b.push(loud(16000 * MIN_TAIL_SECONDS));
    b.flush();
    expect(clips).toHaveLength(1);
    b.push(loud(1000));
    b.flush();
    expect(clips).toHaveLength(1);
  });
});

describe('startMeetingCapture', () => {
  class Ctx {
    static all: Ctx[] = [];
    sampleRate = 16000;
    destination = {};
    proc: { onaudioprocess: ((e: unknown) => void) | null } = { onaudioprocess: null };
    closed = false;
    constructor() {
      Ctx.all.push(this);
    }
    resume = () => Promise.resolve();
    createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
    createScriptProcessor = () => ({
      ...this.proc,
      connect() {},
      disconnect() {},
      set onaudioprocess(f: never) {
        this.__f = f;
      },
      get onaudioprocess() {
        return this.__f;
      },
      __f: null as never,
    });
    createGain = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} });
    close = () => {
      this.closed = true;
      return Promise.resolve();
    };
  }
  const stream = (tracks = 1) =>
    ({
      getAudioTracks: () => Array.from({ length: tracks }, () => ({})),
      getTracks: () => [{ stop: stopSpy }],
    }) as unknown as MediaStream;
  const stopSpy = vi.fn();

  it('rejects a stream with no audio track', () => {
    vi.stubGlobal('MediaStream', function () {});
    expect(() =>
      startMeetingCapture({ mic: stream(0) }, () => {}, { AudioContextImpl: Ctx as never }),
    ).toThrow(/no audio track/);
  });

  it('captures system audio from a PCM feed, with no stream or screen involved', () => {
    const clips: Array<[string, string]> = [];
    let push: ((pcm: Int16Array) => void) | null = null;
    const unsubscribe = vi.fn();
    const stopFeed = vi.fn();
    const capture = startMeetingCapture(
      {
        system: {
          subscribe: (cb) => {
            push = cb;
            return unsubscribe;
          },
          stop: stopFeed,
        },
      },
      (source, wav) => clips.push([source, wav]),
      { AudioContextImpl: Ctx as never, clipSeconds: 1 },
    );
    push!(loud(16000));
    expect(clips).toHaveLength(1);
    expect(clips[0]![0]).toBe('system');
    capture.setPaused(true);
    push!(loud(16000));
    expect(clips).toHaveLength(1);
    capture.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(stopFeed).toHaveBeenCalledOnce();
  });

  it('cleans the call out of the mic when both are captured, so each utterance is heard once', () => {
    const procs: Array<{ onaudioprocess: ((e: unknown) => void) | null }> = [];
    class RecCtx extends Ctx {
      override createScriptProcessor = (): never => {
        const p = {
          onaudioprocess: null as ((e: unknown) => void) | null,
          connect() {},
          disconnect() {},
        };
        procs.push(p);
        return p as never;
      };
    }
    vi.stubGlobal('MediaStream', function () {});
    const clips: Array<[string, string]> = [];
    let push: ((pcm: Int16Array) => void) | null = null;
    const capture = startMeetingCapture(
      {
        mic: stream(),
        system: {
          subscribe: (cb) => {
            push = cb;
            return () => {};
          },
          stop: () => {},
        },
      },
      (source, wav) => clips.push([source, wav]),
      { AudioContextImpl: RecCtx as never, clipSeconds: 4 },
    );
    // Someone on the call talks for 24 s; the laptop speakers put it into the mic 150 ms later.
    let seed = 3;
    const noise = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x80000000 - 1;
    };
    const far = new Int16Array(24 * 16000);
    let lp = 0;
    for (let i = 0; i < far.length; i++) {
      lp += 0.45 * (noise() - lp);
      far[i] = lp * 6000 * Math.max(0, Math.sin((2 * Math.PI * 3.1 * i) / 16000));
    }
    const chunk = 1600;
    for (let at = 0; at < far.length; at += chunk) {
      push!(far.subarray(at, at + chunk));
      const mic = new Float32Array(chunk);
      for (let i = 0; i < chunk; i++) mic[i] = ((far[at + i - 2400] ?? 0) * 0.5) / 32768;
      procs[0]!.onaudioprocess!({ inputBuffer: { getChannelData: () => mic } });
    }
    capture.stop();
    const heard = (source: string): number => clips.filter(([s]) => s === source).length;
    expect(heard('system')).toBeGreaterThanOrEqual(5);
    // The mic clips that survive are only the first seconds, before the canceller has locked on.
    expect(heard('mic')).toBeLessThanOrEqual(2);
  });

  it('rejects when there is nothing to capture', () => {
    expect(() => startMeetingCapture({}, () => {}, { AudioContextImpl: Ctx as never })).toThrow(
      /no audio sources/,
    );
  });
});
