import { describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { createWhisper, pcm16ToWav } from '../src/audio/whisper.js';
import { ParakeetWhisperBackend, PARAKEET_MODEL_FILES } from '../src/audio/parakeet.js';

const logger = pino({ level: 'silent' });

function modelDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'parakeet-'));
  for (const f of PARAKEET_MODEL_FILES) writeFileSync(join(dir, f), '');
  return dir;
}

function fakeSherpa(onDecode: (samples: Float32Array) => Promise<string>, configs: unknown[] = []) {
  return async () => ({
    OfflineRecognizer: class {
      constructor(config: unknown) {
        configs.push(config);
      }
      createStream() {
        const s = {
          samples: new Float32Array(0),
          acceptWaveform(w: { samples: Float32Array }) {
            s.samples = w.samples;
          },
        };
        return s;
      }
      async decodeAsync(s: { samples: Float32Array }) {
        return { text: ` ${await onDecode(s.samples)} ` };
      }
    },
  });
}

describe('Parakeet backend', () => {
  test('is built by createWhisper and offers an unmetered, tighter live preview', () => {
    const w = createWhisper({ backend: 'parakeet', logger, parakeetModelDir: '/nope' });
    expect(w).toBeInstanceOf(ParakeetWhisperBackend);
    expect(w.supportsLivePartials).toBe(true);
    expect(w.livePartialStepSamples).toBeLessThan(16000);
  });

  test('a missing model dir is a loud error naming PARAKEET_MODEL_DIR', async () => {
    const w = new ParakeetWhisperBackend({ logger, modelDir: undefined });
    await expect(w.transcribe(new Int16Array(16000))).rejects.toThrow(/PARAKEET_MODEL_DIR/);
  });

  test('an incomplete model dir names the missing files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parakeet-'));
    const w = new ParakeetWhisperBackend({ logger, modelDir: dir });
    await expect(w.transcribe(new Int16Array(16000))).rejects.toThrow(/encoder\.int8\.onnx/);
  });

  test('transcribes PCM as floats and trims the text', async () => {
    let seen: Float32Array | undefined;
    const configs: unknown[] = [];
    const w = new ParakeetWhisperBackend({
      logger,
      modelDir: modelDir(),
      loadSherpa: fakeSherpa(async (s) => {
        seen = s;
        return 'Hello, world.';
      }, configs),
    });
    const text = await w.transcribe(Int16Array.of(16384, -16384));
    expect(text).toBe('Hello, world.');
    expect([...seen!]).toEqual([0.5, -0.5]);
    expect(JSON.stringify(configs[0])).toContain('nemo_transducer');
  });

  test('decodes one at a time, in the order asked, so a final queues behind a live pass', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const w = new ParakeetWhisperBackend({
      logger,
      modelDir: modelDir(),
      loadSherpa: fakeSherpa(async () => {
        const id = `d${n++}`;
        order.push(`start ${id}`);
        if (id === 'd0') await gate;
        order.push(`end ${id}`);
        return id;
      }),
    });
    const live = w.transcribe(new Int16Array(100), { priority: 'partial' });
    const final = w.transcribe(new Int16Array(100), { priority: 'final' });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['start d0']);
    release();
    expect(await Promise.all([live, final])).toEqual(['d0', 'd1']);
    expect(order).toEqual(['start d0', 'end d0', 'start d1', 'end d1']);
  });

  test('a failed pass does not wedge the queue', async () => {
    let n = 0;
    const w = new ParakeetWhisperBackend({
      logger,
      modelDir: modelDir(),
      loadSherpa: fakeSherpa(async () => {
        if (n++ === 0) throw new Error('boom');
        return 'ok';
      }),
    });
    await expect(w.transcribe(new Int16Array(10))).rejects.toThrow('boom');
    expect(await w.transcribe(new Int16Array(10))).toBe('ok');
  });

  test('a wav clip is read as PCM; a compressed clip goes through the decoder', async () => {
    const pcm = Int16Array.of(1, 2, 3);
    const seen: number[] = [];
    const w = new ParakeetWhisperBackend({
      logger,
      modelDir: modelDir(),
      loadSherpa: fakeSherpa(async (s) => {
        seen.push(s.length);
        return 'clip';
      }),
      decodeClip: async () => new Int16Array(7),
    });
    expect(await w.transcribeClip(pcm16ToWav(pcm, 16000), 'wav')).toBe('clip');
    expect(await w.transcribeClip(Buffer.from('m4a'), 'm4a')).toBe('clip');
    expect(seen).toEqual([3, 7]);
  });

  test('past five seconds a live pass stops re-reading the start; a final still reads everything', async () => {
    const lengths: number[] = [];
    // Every second of audio is one word; every fifth ends a sentence.
    const sherpa = async () => ({
      OfflineRecognizer: class {
        createStream() {
          const st = {
            samples: new Float32Array(0),
            acceptWaveform(w: { samples: Float32Array }) {
              st.samples = w.samples;
            },
          };
          return st;
        }
        async decodeAsync(st: { samples: Float32Array }) {
          const secs = Math.floor(st.samples.length / 16000);
          lengths.push(secs);
          const tokens = Array.from({ length: secs }, (_, i) =>
            i % 5 === 4 ? ` w${i}.` : ` w${i}`,
          );
          return {
            text: tokens.join('').trim(),
            tokens,
            timestamps: tokens.map((_, i) => i),
            durations: tokens.map(() => 1),
          };
        }
      },
    });
    const w = new ParakeetWhisperBackend({ logger, modelDir: modelDir(), loadSherpa: sherpa });
    const audio = new Int16Array(16000 * 14).fill(7);
    const at = (secs: number) => audio.subarray(0, secs * 16000);
    expect(await w.transcribe(at(6), { priority: 'partial' })).toBe('w0 w1 w2 w3 w4. w5');
    await w.transcribe(at(10), { priority: 'partial' }); // 10 s tail: freezes the head at the last boundary 1.5 s back
    lengths.length = 0;
    const live = await w.transcribe(at(14), { priority: 'partial' });
    expect(lengths).toEqual([14 - 5]); // started after the frozen "w0 w1 w2 w3 w4."
    expect(live.startsWith('w0 w1 w2 w3 w4. w0')).toBe(true); // the head is kept, tail words restart in the fake
    lengths.length = 0;
    await w.transcribe(at(14), { priority: 'final' });
    expect(lengths).toEqual([14]);
    // A different utterance (new head audio) is read from its start.
    lengths.length = 0;
    await w.transcribe(new Int16Array(16000 * 14).fill(9), { priority: 'partial' });
    expect(lengths[0]).toBe(14);
  });
});
