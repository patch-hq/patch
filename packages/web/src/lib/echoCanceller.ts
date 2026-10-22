// echoCanceller — acoustic echo cancellation for Meeting mode. On laptop
// speakers the mic hears the call as well as the person at the keyboard. The
// system-audio tap is the exact far-end signal, so it is the reference: the
// mic is cleaned of it before it is cut into clips and transcribed, and what
// is left is the local speaker only.
//
// Three stages, all at 16 kHz mono:
//  1. Delay: the two pipelines (native tap over IPC, Web Audio mic) and the
//     speaker-to-mic path each add latency, so the far-end/mic offset is
//     estimated by GCC-PHAT cross-correlation, re-checked every second.
//  2. Adaptive filter: a 512-tap NLMS filter, aligned by that delay, subtracts
//     its estimate of the echo.
//  3. Residual gate: what the filter cannot model (reverb tails, speaker
//     distortion) is muted while the far end is speaking and the filter is
//     clearly cancelling, i.e. the mic holds echo and nothing else. Local
//     speech leaves a large residual, so it passes untouched.
//
// Until a delay has been found with confidence the mic passes through
// unchanged (`locked` is false): there is nothing to cancel, e.g. headphones.

import { MIC_SAMPLE_RATE } from './pcmDownsample.js';

const RATE = MIC_SAMPLE_RATE;
/** The mic is held back this long so the far end it echoes has always arrived. */
const HOLD = 4096;
const TAPS = 512;
/** The filter reaches this far before the estimated delay, to cover a slightly early estimate. */
const LEAD = 64;
const MU = 0.15;
const FRAME = 320;
const FAR_RING = 1 << 17;
const MAX_LAG = RATE; // far end may lead its echo by up to a second
const SEG = 12288;
/** The far end may also arrive up to this much after the mic echo of it (pipeline skew). */
const MAX_LEAD = 4096;
const FFT = 32768;
const ESTIMATE_EVERY = RATE;
const PEAK_RATIO = 7;
/** A frame's far-end energy (mean square, PCM16 units) below which it is silence. */
const FAR_FLOOR = 1e4;
/** Keeps the NLMS step sane when the far end is near-silent (about 100 RMS across the taps). */
const REGULARISE = TAPS * FAR_FLOOR;

function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a]! += xr;
        im[a]! += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

export class EchoCanceller {
  private far = new Float32Array(FAR_RING);
  private farCount = 0;

  /** Mic samples waiting out the hold, then waiting to fill a frame. */
  private held: number[] = [];
  private micCount = 0; // absolute index of the next mic sample to be processed
  private frame: number[] = [];

  private weights = new Float32Array(TAPS);
  private delay: number | null = null;
  private sinceEstimate = 0;
  private gate = 1;

  /** True once the far end has been found in the mic and is being cancelled. */
  get locked(): boolean {
    return this.delay !== null;
  }

  /** Samples of the system-audio tap, as they arrive. */
  pushFar(pcm: Int16Array): void {
    for (let i = 0; i < pcm.length; i++) this.far[(this.farCount + i) & (FAR_RING - 1)] = pcm[i]!;
    this.farCount += pcm.length;
  }

  /** Samples of the mic, as they arrive. Returns cleaned samples, `HOLD` behind. */
  processMic(pcm: Int16Array): Int16Array {
    for (let i = 0; i < pcm.length; i++) this.held.push(pcm[i]!);
    const ready = Math.max(0, this.held.length - HOLD);
    return this.drain(ready);
  }

  /** Cleaned samples for everything still held back. Call on stop. */
  flush(): Int16Array {
    const out = this.drain(this.held.length);
    if (this.frame.length > 0) {
      const rest = this.cleanFrame(this.frame, true);
      this.frame = [];
      const merged = new Int16Array(out.length + rest.length);
      merged.set(out);
      merged.set(rest, out.length);
      return merged;
    }
    return out;
  }

  private drain(count: number): Int16Array {
    const input = this.held.splice(0, count);
    const out: number[] = [];
    for (const s of input) {
      this.frame.push(s);
      if (this.frame.length === FRAME) {
        out.push(...this.cleanFrame(this.frame, false));
        this.frame = [];
      }
    }
    return Int16Array.from(out);
  }

  private farAt(index: number): number {
    if (index < 0 || index >= this.farCount || index < this.farCount - FAR_RING) return 0;
    return this.far[index & (FAR_RING - 1)]!;
  }

  private cleanFrame(frame: number[], partial: boolean): Int16Array {
    const start = this.micCount;
    this.micCount += frame.length;
    this.sinceEstimate += frame.length;
    this.remember(frame);
    if (!partial && this.sinceEstimate >= ESTIMATE_EVERY) {
      this.sinceEstimate = 0;
      this.estimateDelay(this.micCount);
    }
    const out = new Int16Array(frame.length);
    if (this.delay === null) {
      for (let i = 0; i < frame.length; i++) out[i] = frame[i]!;
      return out;
    }

    const lag = this.delay - LEAD;
    const w = this.weights;
    let eMic = 0;
    let eRes = 0;
    let eFar = 0;
    for (let i = 0; i < frame.length; i++) eFar += this.farAt(start + i - lag) ** 2;
    eFar /= frame.length;
    // A quiet far end teaches the filter nothing; adapting on it lets the mic's own voice in.
    const adapt = eFar > FAR_FLOOR;
    const res = new Float32Array(frame.length);
    for (let i = 0; i < frame.length; i++) {
      const n = start + i;
      let y = 0;
      let norm = REGULARISE;
      for (let k = 0; k < TAPS; k++) {
        const x = this.farAt(n - lag - k);
        y += w[k]! * x;
        norm += x * x;
      }
      const e = frame[i]! - y;
      res[i] = e;
      eMic += frame[i]! ** 2;
      eRes += e * e;
      if (!adapt) continue;
      const g = (MU * e) / norm;
      for (let k = 0; k < TAPS; k++) w[k]! += g * this.farAt(n - lag - k);
    }
    eMic /= frame.length;
    eRes /= frame.length;

    // Far end speaking and the filter explains nearly all of the mic: only echo is left in it.
    const echoOnly = eFar > FAR_FLOOR && eRes < 0.1 * eMic;
    const target = echoOnly ? 0.05 : 1;
    for (let i = 0; i < frame.length; i++) {
      this.gate += (target - this.gate) * (target < this.gate ? 0.02 : 0.005);
      out[i] = Math.max(-32768, Math.min(32767, Math.round(res[i]! * this.gate)));
    }
    return out;
  }

  /** GCC-PHAT between the last `SEG` mic samples before `micEnd` and the far end ahead of them. */
  private estimateDelay(micEnd: number): void {
    const t0 = micEnd - SEG;
    if (t0 - MAX_LAG < 0 || this.farCount <= t0) return;
    const m = new Float64Array(FFT);
    const f = new Float64Array(FFT);
    const mi = new Float64Array(FFT);
    const fi = new Float64Array(FFT);
    const seg = this.recent;
    if (this.recentFilled < SEG) return;
    for (let i = 0; i < SEG; i++) m[i] = seg[i]!;
    for (let j = 0; j < SEG + MAX_LAG + MAX_LEAD; j++) f[j] = this.farAt(t0 - MAX_LAG + j);
    fft(m, mi, false);
    fft(f, fi, false);
    // F · conj(M), phase transform.
    for (let k = 0; k < FFT; k++) {
      const re = f[k]! * m[k]! + fi[k]! * mi[k]!;
      const im = fi[k]! * m[k]! - f[k]! * mi[k]!;
      const mag = Math.hypot(re, im) + 1e-3;
      m[k] = re / mag;
      mi[k] = im / mag;
    }
    fft(m, mi, true);
    let best = 0;
    let bestV = 0;
    let sum = 0;
    for (let s = 0; s <= MAX_LAG + MAX_LEAD; s++) {
      const v = Math.abs(m[s]!);
      sum += v * v;
      if (v > bestV) {
        bestV = v;
        best = s;
      }
    }
    const rms = Math.sqrt(sum / (MAX_LAG + MAX_LEAD + 1));
    if (rms === 0 || bestV < PEAK_RATIO * rms) return;
    const delay = MAX_LAG - best;
    if (this.delay === null || Math.abs(delay - this.delay) > 8) {
      this.delay = delay;
      this.weights.fill(0);
    }
  }

  private recent = new Float32Array(SEG);
  private recentFilled = 0;

  /** Keeps the last `SEG` raw mic samples for the delay estimate. */
  private remember(frame: number[]): void {
    this.recent.copyWithin(0, frame.length);
    for (let i = 0; i < frame.length; i++) this.recent[SEG - frame.length + i] = frame[i]!;
    this.recentFilled = Math.min(SEG, this.recentFilled + frame.length);
  }
}
