import { describe, expect, it, vi } from 'vitest';
import {
  SILENCE_RMS,
  rmsOfPcm16,
  startMeetingCapture,
  AUTO_END_SILENCE_SECONDS,
} from '../lib/meetingCapture.js';

const loud = (n: number): Int16Array => new Int16Array(n).fill(8000);

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
    const heard: Array<[string, number]> = [];
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
      (source, pcm) => heard.push([source, pcm.length]),
      { AudioContextImpl: Ctx as never },
    );
    push!(loud(16000));
    expect(heard).toEqual([['system', 16000]]);
    capture.setPaused(true);
    push!(loud(16000));
    expect(heard).toHaveLength(1);
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
    const loudness: Record<string, number[]> = { mic: [], system: [] };
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
      (source, pcm) => loudness[source]!.push(rmsOfPcm16(pcm)),
      { AudioContextImpl: RecCtx as never },
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
    // Once the canceller has locked on (a few seconds in), the mic is near silence.
    const settled = loudness.mic!.slice(Math.floor(loudness.mic!.length / 2));
    const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
    expect(mean(loudness.system!)).toBeGreaterThan(0.02);
    expect(mean(settled)).toBeLessThan(SILENCE_RMS * 2);
  });

  it('rejects when there is nothing to capture', () => {
    expect(() => startMeetingCapture({}, () => {}, { AudioContextImpl: Ctx as never })).toThrow(
      /no audio sources/,
    );
  });
});

describe('auto-end on a long silence', () => {
  const feed = () => {
    let cb: ((p: Int16Array) => void) | null = null;
    return {
      push: (p: Int16Array) => cb!(p),
      src: {
        subscribe: (f: (p: Int16Array) => void) => {
          cb = f;
          return () => {};
        },
        stop: () => {},
      },
    };
  };
  const quiet = (s: number): Int16Array => new Int16Array(16000 * s);

  it('fires once when the far end has said nothing for the whole window', () => {
    const f = feed();
    const onSilence = vi.fn();
    startMeetingCapture({ system: f.src }, () => {}, {
      AudioContextImpl: class {} as never,
      onSilence,
    });
    for (let i = 0; i < AUTO_END_SILENCE_SECONDS / 10 - 1; i++) f.push(quiet(10));
    expect(onSilence).not.toHaveBeenCalled();
    f.push(quiet(10));
    f.push(quiet(10));
    f.push(quiet(10));
    expect(onSilence).toHaveBeenCalledTimes(1);
  });

  it('speech resets the window', () => {
    const f = feed();
    const onSilence = vi.fn();
    startMeetingCapture({ system: f.src }, () => {}, {
      AudioContextImpl: class {} as never,
      onSilence,
    });
    for (let i = 0; i < 25; i++) f.push(quiet(10));
    f.push(loud(16000 * 10));
    for (let i = 0; i < 25; i++) f.push(quiet(10));
    expect(onSilence).not.toHaveBeenCalled();
  });
});
