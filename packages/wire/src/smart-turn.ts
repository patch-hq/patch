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

let tables: {
  cos: Float64Array;
  sin: Float64Array;
  window: Float64Array;
  mel: Float64Array[];
} | null = null;
function getTables(): NonNullable<typeof tables> {
  if (tables) return tables;
  const cos = new Float64Array(N_BINS * N_FFT);
  const sin = new Float64Array(N_BINS * N_FFT);
  for (let k = 0; k < N_BINS; k++) {
    for (let n = 0; n < N_FFT; n++) {
      const a = (2 * Math.PI * k * n) / N_FFT;
      cos[k * N_FFT + n] = Math.cos(a);
      sin[k * N_FFT + n] = Math.sin(a);
    }
  }
  // Periodic Hann, as numpy/transformers' window_function(400, "hann").
  const window = new Float64Array(N_FFT);
  for (let n = 0; n < N_FFT; n++) window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT);
  tables = { cos, sin, window, mel: melFilters() };
  return tables;
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
  const { cos, sin, window, mel } = getTables();

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
    for (let k = 0; k < N_BINS; k++) {
      let re = 0;
      let im = 0;
      const row = k * N_FFT;
      for (let n = 0; n < N_FFT; n++) {
        re += frame[n]! * cos[row + n]!;
        im -= frame[n]! * sin[row + n]!;
      }
      power[k] = re * re + im * im;
    }
    for (let m = 0; m < N_MELS; m++) {
      const filter = mel[m]!;
      let e = 0;
      for (let k = 0; k < N_BINS; k++) e += filter[k]! * power[k]!;
      const v = Math.log10(Math.max(e, 1e-10));
      out[m * N_FRAMES + t] = v;
      if (v > max) max = v;
    }
  }
  const features = new Float32Array(out.length);
  for (let i = 0; i < out.length; i++) features[i] = (Math.max(out[i]!, max - 8) + 4) / 4;
  return features;
}
