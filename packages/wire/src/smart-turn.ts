// Smart Turn's input features (spec/07 § Dictation mode → Knowing when the
// speaker has finished). Shared by every place that runs the model — the host
// for dictation, the desktop app for a direct call — so the features are
// computed one way. Pure TypeScript: the model run itself is the caller's.
//
// The model takes the LAST 8 s of 16 kHz audio, zero-padded at the FRONT, as
// Whisper log-mel features [1, 80, 800], and returns that probability. The
// feature extraction below is a port of transformers' WhisperFeatureExtractor
// (do_normalize=True), checked against it in test/smart-turn.test.ts.

/**
 * The model every surface runs for a direct call, served with the SPA by the
 * Patch server (the release fetches it, pinned, with `scripts/fetch-vendor.mjs`).
 * A surface checks the bytes against this before loading them.
 */
export const SMART_TURN_MODEL = {
  path: '/app/models/smart_turn.onnx',
  sha256: '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f',
} as const;
/** Smart Turn's own decision threshold: at or above this, the speaker has finished. */
export const TURN_COMPLETE = 0.5;
/** Quiet this long after speech asks Smart Turn whether the speaker has finished. */
export const TURN_CHECK_PAUSE_MS = 700;

export const SMART_TURN_SAMPLE_RATE = 16000;
const N_SAMPLES = 8 * SMART_TURN_SAMPLE_RATE;
const N_FFT = 400;
const HOP = 160;
export const N_MELS = 80;
const N_BINS = N_FFT / 2 + 1;
/** STFT frames with centre padding, less the last one Whisper drops. */
export const N_FRAMES = N_SAMPLES / HOP;

/** The last 8 s of `pcm` as floats in [-1, 1], zero-padded at the front. */
export function lastEightSeconds(pcm: Int16Array): Float64Array {
  const out = new Float64Array(N_SAMPLES);
  const take = Math.min(pcm.length, N_SAMPLES);
  const from = pcm.length - take;
  const at = N_SAMPLES - take;
  for (let i = 0; i < take; i++) out[at + i] = (pcm[from + i] ?? 0) / 32768;
  return out;
}

// transformers' mel_filter_bank(…, norm="slaney", mel_scale="slaney").
function hzToMel(f: number): number {
  return f < 1000 ? (3 * f) / 200 : 15 + (Math.log(f / 1000) * 27) / Math.log(6.4);
}
function melToHz(m: number): number {
  return m < 15 ? (200 * m) / 3 : 1000 * Math.exp((Math.log(6.4) * (m - 15)) / 27);
}

function melFilters(): Float64Array[] {
  const maxHz = SMART_TURN_SAMPLE_RATE / 2;
  const melMax = hzToMel(maxHz);
  const edges: number[] = [];
  for (let i = 0; i < N_MELS + 2; i++) edges.push(melToHz((melMax * i) / (N_MELS + 1)));
  const filters: Float64Array[] = [];
  for (let m = 0; m < N_MELS; m++) {
    const lo = edges[m]!;
    const mid = edges[m + 1]!;
    const hi = edges[m + 2]!;
    const enorm = 2 / (hi - lo);
    const row = new Float64Array(N_BINS);
    for (let k = 0; k < N_BINS; k++) {
      const f = (maxHz * k) / (N_BINS - 1);
      const down = (f - lo) / (mid - lo);
      const up = (hi - f) / (hi - mid);
      row[k] = Math.max(0, Math.min(down, up)) * enorm;
    }
    filters.push(row);
  }
  return filters;
}

/**
 * The power spectrum of one 400-sample frame, by a mixed-radix FFT (Stockham
 * autosort, radices 5·5·2·2·2·2 = 400). The same numbers as the plain DFT, in
 * about a tenth of the work: this is most of what a turn check costs on a device.
 */
const RADICES = [5, 5, 2, 2, 2, 2] as const;

interface Tables {
  /** W^e = exp(-2πi·e/N_FFT): re = wRe[e], im = wIm[e]. */
  wRe: Float64Array;
  wIm: Float64Array;
  window: Float64Array;
  /** Each mel filter's weights over its non-zero bins, from `melFrom`. */
  mel: Float64Array[];
  melFrom: number[];
}
let tables: Tables | null = null;
function getTables(): Tables {
  if (tables) return tables;
  const wRe = new Float64Array(N_FFT);
  const wIm = new Float64Array(N_FFT);
  for (let e = 0; e < N_FFT; e++) {
    wRe[e] = Math.cos((2 * Math.PI * e) / N_FFT);
    wIm[e] = -Math.sin((2 * Math.PI * e) / N_FFT);
  }
  // Periodic Hann, as numpy/transformers' window_function(400, "hann").
  const window = new Float64Array(N_FFT);
  for (let n = 0; n < N_FFT; n++) window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT);
  const mel: Float64Array[] = [];
  const melFrom: number[] = [];
  for (const row of melFilters()) {
    let from = 0;
    while (from < N_BINS && row[from] === 0) from++;
    let to = N_BINS;
    while (to > from && row[to - 1] === 0) to--;
    mel.push(row.slice(from, to));
    melFrom.push(from);
  }
  tables = { wRe, wIm, window, mel, melFrom };
  return tables;
}

const fftRe = [new Float64Array(N_FFT), new Float64Array(N_FFT)];
const fftIm = [new Float64Array(N_FFT), new Float64Array(N_FFT)];
const vRe = new Float64Array(5);
const vIm = new Float64Array(5);

/** `power[k] = |X[k]|²` for k in [0, N_BINS) of the real frame `frame`. */
export function powerSpectrum(frame: Float64Array, power: Float64Array): void {
  const { wRe, wIm } = getTables();
  let xRe = fftRe[0]!;
  let xIm = fftIm[0]!;
  let yRe = fftRe[1]!;
  let yIm = fftIm[1]!;
  xRe.set(frame);
  xIm.fill(0);
  let ns = 1;
  for (const r of RADICES) {
    const stride = N_FFT / r;
    const step = N_FFT / (ns * r);
    for (let j = 0; j < stride; j++) {
      const k = j % ns;
      for (let a = 0; a < r; a++) {
        const re = xRe[j + a * stride]!;
        const im = xIm[j + a * stride]!;
        const e = (k * a * step) % N_FFT;
        vRe[a] = re * wRe[e]! - im * wIm[e]!;
        vIm[a] = re * wIm[e]! + im * wRe[e]!;
      }
      const out = Math.floor(j / ns) * ns * r + k;
      for (let q = 0; q < r; q++) {
        let sRe = 0;
        let sIm = 0;
        for (let a = 0; a < r; a++) {
          const e = ((a * q) % r) * stride;
          sRe += vRe[a]! * wRe[e]! - vIm[a]! * wIm[e]!;
          sIm += vRe[a]! * wIm[e]! + vIm[a]! * wRe[e]!;
        }
        yRe[out + q * ns] = sRe;
        yIm[out + q * ns] = sIm;
      }
    }
    [xRe, yRe] = [yRe, xRe];
    [xIm, yIm] = [yIm, xIm];
    ns *= r;
  }
  for (let k = 0; k < N_BINS; k++) power[k] = xRe[k]! * xRe[k]! + xIm[k]! * xIm[k]!;
}

/**
 * Whisper log-mel features for exactly 8 s of audio, as [80, 800] row-major:
 * normalise the waveform to zero mean / unit variance, centred STFT with
 * reflect padding, power spectrum, slaney mel, log10, clamp to max − 8, then
 * (x + 4) / 4.
 */
export function whisperFeatures(audio: Float64Array): Float32Array {
  if (audio.length !== N_SAMPLES)
    throw new Error(`expected ${N_SAMPLES} samples, got ${audio.length}`);
  const { window, mel, melFrom } = getTables();

  let mean = 0;
  for (let i = 0; i < audio.length; i++) mean += audio[i]!;
  mean /= audio.length;
  let variance = 0;
  for (let i = 0; i < audio.length; i++) variance += (audio[i]! - mean) ** 2;
  variance /= audio.length;
  const scale = 1 / Math.sqrt(variance + 1e-7);

  const pad = N_FFT / 2;
  const padded = new Float64Array(audio.length + 2 * pad);
  for (let i = 0; i < audio.length; i++) padded[pad + i] = (audio[i]! - mean) * scale;
  for (let i = 0; i < pad; i++) {
    padded[pad - 1 - i] = padded[pad + 1 + i]!;
    padded[pad + audio.length + i] = padded[pad + audio.length - 2 - i]!;
  }

  const out = new Float64Array(N_MELS * N_FRAMES);
  const frame = new Float64Array(N_FFT);
  const power = new Float64Array(N_BINS);
  let max = -Infinity;
  for (let t = 0; t < N_FRAMES; t++) {
    const start = t * HOP;
    for (let n = 0; n < N_FFT; n++) frame[n] = padded[start + n]! * window[n]!;
    powerSpectrum(frame, power);
    for (let m = 0; m < N_MELS; m++) {
      const filter = mel[m]!;
      const from = melFrom[m]!;
      let e = 0;
      for (let k = 0; k < filter.length; k++) e += filter[k]! * power[from + k]!;
      const v = Math.log10(Math.max(e, 1e-10));
      out[m * N_FRAMES + t] = v;
      if (v > max) max = v;
    }
  }
  const features = new Float32Array(out.length);
  for (let i = 0; i < out.length; i++) features[i] = (Math.max(out[i]!, max - 8) + 4) / 4;
  return features;
}
