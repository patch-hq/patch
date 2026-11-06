// Smart Turn's input features must match transformers' WhisperFeatureExtractor
// exactly, or the model scores a different signal from the one it was trained
// on. The reference values below came from WhisperFeatureExtractor(chunk_length=8)
// with do_normalize=True on the same synthetic chirp (transformers 4.46.3).
import { describe, it, expect, vi } from 'vitest';
import type { WireEvent } from '@patch/wire';
import {
  createSmartTurnDetector,
  lastEightSeconds,
  pcmFromWav,
  whisperFeatures,
  N_FRAMES,
} from '../src/audio/smartTurn.js';
import { handleTurnCheck, TurnModelUnavailableError } from '../src/index.js';

function chirp(): Int16Array {
  const n = 3 * 16000;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / 16000;
    const x =
      0.3 * Math.sin(2 * Math.PI * (220 + 200 * t) * t) + 0.05 * Math.sin(2 * Math.PI * 1500 * t);
    pcm[i] = Math.round(Math.fround(x) * 32768);
  }
  return pcm;
}

const REFERENCE: [number, number, number][] = [
  [0, 0, -0.21808099746704102],
  [0, 799, 0.5407990217208862],
  [20, 750, -0.032506346702575684],
  [40, 600, 0.08442544937133789],
  [79, 799, 0.006798207759857178],
  [30, 780, 0.6598823666572571],
  [60, 790, -0.21808099746704102],
];

describe('Smart Turn features', () => {
  it('match WhisperFeatureExtractor on the reference chirp', () => {
    const f = whisperFeatures(lastEightSeconds(chirp()));
    expect(f.length).toBe(80 * N_FRAMES);
    for (const [mel, frame, want] of REFERENCE) {
      expect(f[mel * N_FRAMES + frame]).toBeCloseTo(want, 4);
    }
    let mean = 0;
    for (const v of f) mean += v;
    expect(mean / f.length).toBeCloseTo(-0.10897202044725418, 4);
  });

  it('keeps the LAST 8 s, padding a short clip at the front', () => {
    const short = new Int16Array([1000, -1000]);
    const padded = lastEightSeconds(short);
    expect(padded.length).toBe(128000);
    expect(padded[127998]).toBeCloseTo(1000 / 32768);
    expect(padded[0]).toBe(0);
    const long = new Int16Array(200000);
    long[199999] = 32767;
    long[0] = 5;
    const cut = lastEightSeconds(long);
    expect(cut[127999]).toBeCloseTo(32767 / 32768);
    expect(cut.includes(5 / 32768)).toBe(false);
  });

  it('refuses audio that is not exactly 8 s', () => {
    expect(() => whisperFeatures(new Float64Array(10))).toThrow(/expected 128000/);
  });
});

function wav(pcm: Int16Array, rate = 16000, channels = 1): Buffer {
  const b = Buffer.alloc(44 + pcm.length * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + pcm.length * 2, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2 * channels, 28);
  b.writeUInt16LE(2 * channels, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i]!, 44 + i * 2);
  return b;
}

describe('pcmFromWav', () => {
  it('reads 16 kHz mono PCM16', () => {
    expect(Array.from(pcmFromWav(wav(new Int16Array([1, -2, 300]))))).toEqual([1, -2, 300]);
  });
  it('refuses anything else, saying what it was', () => {
    expect(() => pcmFromWav(wav(new Int16Array([1]), 48000))).toThrow(/48000 Hz/);
    expect(() => pcmFromWav(wav(new Int16Array([1]), 16000, 2))).toThrow(/2 ch/);
    expect(() => pcmFromWav(Buffer.from('not audio at all'))).toThrow(/not a WAV/);
  });
});

describe('handleTurnCheck', () => {
  const logger = { warn: vi.fn() } as unknown as Parameters<typeof handleTurnCheck>[3];
  const request = (audioBase64: string) => ({
    type: 'patch.voice.turn_check_request' as const,
    requestId: 'r1',
    audioBase64,
  });

  it('answers with the model’s probability for the clip', async () => {
    const sent: WireEvent[] = [];
    const probability = vi.fn(async () => 0.91);
    await handleTurnCheck(
      request(wav(new Int16Array([5, 6])).toString('base64')),
      async () => ({ probability }),
      (e) => sent.push(e),
      logger,
    );
    expect(Array.from(probability.mock.calls[0]![0])).toEqual([5, 6]);
    expect(sent).toEqual([
      { type: 'patch.voice.turn_check_response', requestId: 'r1', ok: true, probability: 0.91 },
    ]);
  });

  it('says why when the clip is not WAV, the model is missing, or inference throws', async () => {
    const sent: WireEvent[] = [];
    const send = (e: WireEvent): void => {
      sent.push(e);
    };
    await handleTurnCheck(
      request(Buffer.from('nope').toString('base64')),
      async () => ({ probability: async () => 1 }),
      send,
      logger,
    );
    await handleTurnCheck(
      request(wav(new Int16Array([1])).toString('base64')),
      async () => {
        throw new TurnModelUnavailableError('no smart_turn.onnx');
      },
      send,
      logger,
    );
    await handleTurnCheck(
      request(wav(new Int16Array([1])).toString('base64')),
      async () => ({
        probability: async () => {
          throw new Error('bad tensor');
        },
      }),
      send,
      logger,
    );
    expect(sent.map((e) => (e as { error?: { code: string; message: string } }).error)).toEqual([
      { code: 'unsupported_format', message: 'not a WAV file' },
      { code: 'model_unavailable', message: 'no smart_turn.onnx' },
      { code: 'internal', message: 'bad tensor' },
    ]);
  });
});

// The real model, when this host has it (TURN_MODEL_PATH). CI's host build
// proves the file ships; this proves the session loads and runs.
const MODEL = process.env['TURN_MODEL_PATH'];
describe.skipIf(!MODEL)('Smart Turn on the real model', () => {
  it('loads and scores a clip as a probability in [0, 1]', async () => {
    const det = await createSmartTurnDetector(MODEL!);
    const p = await det.probability(chirp());
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });
});
