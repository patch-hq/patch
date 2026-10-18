// Smart Turn end-of-turn detection (spec/07 § Dictation mode).
//
// Dictation mode used to send whatever was said once the speaker had been quiet
// for a fixed pause, so a pause to think mid-sentence sent half a message. Smart
// Turn (pipecat-ai/smart-turn, BSD-2) is a small Whisper-encoder classifier that
// listens to HOW the last few seconds were said — pitch, pace, a trailing "and…"
// — and gives the probability the speaker has finished. The surface asks at each
// short silence and only sends once this says the turn is done.
//
// The model takes the LAST 8 s of 16 kHz audio, zero-padded at the FRONT, as
// Whisper log-mel features [1, 80, 800], and returns that probability. The
// feature extraction below is a port of transformers' WhisperFeatureExtractor
// (do_normalize=True), checked against it in test/smart-turn.test.ts.
//
// NO FALLBACK: a model that will not load is an error the surface shows.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundledNativeDir } from '../installPaths.js';

export const SMART_TURN_SAMPLE_RATE = 16000;
const N_SAMPLES = 8 * SMART_TURN_SAMPLE_RATE;
const N_FFT = 400;
const HOP = 160;
const N_MELS = 80;
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

export interface TurnDetector {
  /** Probability in [0, 1] that the speaker has finished, from the end of `pcm` (16 kHz). */
  probability(pcm: Int16Array): Promise<number>;
}

interface Ort {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Tensor: new (type: string, data: any, dims: number[]) => unknown;
  InferenceSession: {
    create(
      path: string,
      opts?: object,
    ): Promise<{
      run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
    }>;
  };
}

/**
 * Load the Smart Turn session once. Same onnxruntime the Silero VAD uses: the
 * artifact's own `native/` copy when installed, the workspace dependency from a
 * source checkout.
 */
export async function createSmartTurnDetector(modelPath: string): Promise<TurnDetector> {
  const native = bundledNativeDir();
  const ortModuleName: string = native
    ? pathToFileURL(join(native, 'onnxruntime-node', 'dist', 'index.js')).href
    : 'onnxruntime-node';
  let ort: Ort;
  try {
    ort = (await import(/* @vite-ignore */ ortModuleName)) as Ort;
  } catch (err) {
    throw new Error(
      `Smart Turn: onnxruntime-node not loadable from ${ortModuleName} (${(err as Error).message})`,
    );
  }
  const session = await ort.InferenceSession.create(modelPath, {
    executionMode: 'sequential',
    interOpNumThreads: 1,
  });
  return {
    async probability(pcm: Int16Array): Promise<number> {
      const features = whisperFeatures(lastEightSeconds(pcm));
      const out = await session.run({
        input_features: new ort.Tensor('float32', features, [1, N_MELS, N_FRAMES]),
      });
      const first = Object.values(out)[0];
      const p = first?.data[0];
      if (typeof p !== 'number' || !Number.isFinite(p)) {
        throw new Error('Smart Turn: the model returned no probability');
      }
      return p;
    },
  };
}

/**
 * The samples of a 16 kHz mono PCM16 WAV — the only shape a surface sends.
 * Anything else is refused with what it was, never resampled or guessed at.
 */
export function pcmFromWav(wav: Buffer): Int16Array {
  if (
    wav.length < 12 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('not a WAV file');
  }
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      fmt = {
        format: wav.readUInt16LE(body),
        channels: wav.readUInt16LE(body + 2),
        rate: wav.readUInt32LE(body + 4),
        bits: wav.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before its fmt chunk');
      if (
        fmt.format !== 1 ||
        fmt.channels !== 1 ||
        fmt.rate !== SMART_TURN_SAMPLE_RATE ||
        fmt.bits !== 16
      ) {
        throw new Error(
          `expected 16 kHz mono 16-bit PCM, got format ${fmt.format}, ${fmt.channels} ch, ${fmt.rate} Hz, ${fmt.bits}-bit`,
        );
      }
      const end = Math.min(wav.length, body + size);
      const count = Math.floor((end - body) / 2);
      const pcm = new Int16Array(count);
      for (let i = 0; i < count; i++) pcm[i] = wav.readInt16LE(body + i * 2);
      return pcm;
    }
    at = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}
