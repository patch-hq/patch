import { describe, expect, it } from 'vitest';
import { EchoCanceller } from '../lib/echoCanceller.js';

const RATE = 16000;

/** Deterministic noise in -1..1. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x80000000 - 1;
  };
}

/** Speech-like: low-passed noise under a syllable-rate envelope, with pauses. */
function voice(seconds: number, seed: number, level = 6000): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(Math.round(seconds * RATE));
  let lp = 0;
  let lp2 = 0;
  for (let i = 0; i < out.length; i++) {
    lp += 0.45 * (r() - lp);
    lp2 += 0.3 * (lp - lp2);
    const t = i / RATE;
    const syllable = Math.max(
      0,
      Math.sin(2 * Math.PI * 3.1 * t) + 0.3 * Math.sin(2 * Math.PI * 0.45 * t),
    );
    out[i] = (lp - 0.5 * lp2) * level * syllable;
  }
  return out;
}

/** What a laptop mic hears of the far end: delayed, filtered, attenuated, slightly clipped. */
function room(far: Float32Array, delaySamples: number): Float32Array {
  const taps: [number, number][] = [
    [0, 0.5],
    [23, 0.22],
    [91, -0.12],
    [160, 0.07],
  ];
  const out = new Float32Array(far.length);
  for (let i = 0; i < far.length; i++) {
    let v = 0;
    for (const [d, g] of taps) {
      const j = i - delaySamples - d;
      if (j >= 0) v += g * far[j]!;
    }
    out[i] = Math.tanh(v / 12000) * 12000;
  }
  return out;
}

const toPcm = (x: Float32Array): Int16Array =>
  Int16Array.from(x, (v) => Math.max(-32768, Math.min(32767, Math.round(v))));

function energy(x: ArrayLike<number>, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += (x[i] as number) ** 2;
  return s / Math.max(1, to - from);
}

/** Feed both streams in unequal, unaligned chunks, as the two real pipelines do. */
function run(mic: Float32Array, far: Float32Array): Int16Array {
  const aec = new EchoCanceller();
  const out: Int16Array[] = [];
  const m = toPcm(mic);
  const f = toPcm(far);
  let mi = 0;
  let fi = 0;
  const r = rng(99);
  // Both streams run in real time: the far end's chunks land as the clock passes them.
  while (mi < m.length) {
    const mn = Math.min(1365 + Math.floor((r() + 1) * 400), m.length - mi);
    mi += mn;
    for (;;) {
      const fn = Math.min(800 + Math.floor((r() + 1) * 900), f.length - fi);
      if (fn === 0 || fi + fn > mi) break;
      aec.pushFar(f.subarray(fi, fi + fn));
      fi += fn;
    }
    out.push(aec.processMic(m.subarray(mi - mn, mi)));
  }
  if (fi < f.length) aec.pushFar(f.subarray(fi));
  out.push(aec.flush());
  const all = new Int16Array(out.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of out) {
    all.set(c, o);
    o += c.length;
  }
  return all;
}

const delayed = (x: Float32Array, by: number): Float32Array => {
  const out = new Float32Array(x.length);
  out.set(x.subarray(0, x.length - by), by);
  return out;
};

describe('EchoCanceller', () => {
  it('returns exactly as many samples as it was given, once flushed', () => {
    const far = voice(5, 1);
    const out = run(room(far, 2000), far);
    expect(out.length).toBe(far.length);
  });

  it('removes the far end from the mic when only the far end is speaking', () => {
    const far = voice(25, 1);
    const mic = room(far, 2400);
    const out = run(mic, far);
    const from = 18 * RATE;
    const erle = 10 * Math.log10(energy(mic, from, 25 * RATE) / energy(out, from, 25 * RATE));
    expect(erle).toBeGreaterThan(20);
  });

  it('finds the delay whatever it is, including a mic that lags by a second', () => {
    const far = voice(25, 4);
    const mic = room(far, 15000);
    const out = run(mic, far);
    const from = 18 * RATE;
    const erle = 10 * Math.log10(energy(mic, from, 25 * RATE) / energy(out, from, 25 * RATE));
    expect(erle).toBeGreaterThan(20);
  });

  it('keeps the local speaker intact when they speak alone', () => {
    const far = new Float32Array(15 * RATE);
    const near = voice(15, 7);
    const out = run(near, far);
    expect(energy(out, 4 * RATE, 15 * RATE) / energy(near, 4 * RATE, 15 * RATE)).toBeGreaterThan(
      0.9,
    );
  });

  it('leaves the mic alone with headphones, where nothing of the far end reaches it', () => {
    const far = voice(15, 2);
    const near = voice(15, 8);
    const out = run(near, far);
    expect(energy(out, 4 * RATE, 15 * RATE) / energy(near, 4 * RATE, 15 * RATE)).toBeGreaterThan(
      0.9,
    );
  });

  it('keeps the local speaker while the far end is also speaking, and drops the far end from it', () => {
    const far = voice(40, 1);
    const near = delayed(voice(40, 11, 5000), 0);
    // Local speaker talks only in the last 12 s; before that the far end is alone and the filter learns.
    const gate = new Float32Array(near.length);
    for (let i = 28 * RATE; i < near.length; i++) gate[i] = 1;
    const nearOnly = near.map((v, i) => v * gate[i]!);
    const echo = room(far, 2400);
    const mic = echo.map((v, i) => v + nearOnly[i]!);
    const out = run(mic, far);
    const a = 30 * RATE;
    const b = 40 * RATE;
    // What remains is close to the local speaker, and far from the far end.
    let dotNear = 0;
    let dotEcho = 0;
    for (let i = a; i < b; i++) {
      dotNear += out[i]! * nearOnly[i]!;
      dotEcho += out[i]! * echo[i]!;
    }
    const norm = (x: ArrayLike<number>): number => Math.sqrt(energy(x, a, b) * (b - a));
    const corrNear = dotNear / (norm(out) * norm(nearOnly));
    const corrEcho = dotEcho / (norm(out) * norm(echo));
    expect(corrNear).toBeGreaterThan(0.85);
    expect(Math.abs(corrEcho)).toBeLessThan(0.25);
  });
});
