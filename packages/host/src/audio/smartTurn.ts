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

import {
  N_FRAMES,
  N_MELS,
  SMART_TURN_SAMPLE_RATE,
  lastEightSeconds,
  whisperFeatures,
} from '@patch/wire/smart-turn';
import { ortModuleSpecifier } from '../voiceComponent.js';

export {
  N_FRAMES,
  SMART_TURN_SAMPLE_RATE,
  lastEightSeconds,
  whisperFeatures,
} from '@patch/wire/smart-turn';

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
 * voice component's `native/` copy when installed, the workspace dependency from a
 * source checkout.
 */
export async function createSmartTurnDetector(
  modelPath: string,
  nativeDir?: string,
): Promise<TurnDetector> {
  const ortModuleName: string = ortModuleSpecifier(nativeDir);
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
