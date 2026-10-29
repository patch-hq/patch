// Runs the REAL streaming model. Skipped unless PARAKEET_STREAMING_MODEL_DIR
// and PARAKEET_TEST_WAV (any 16 kHz speech clip) are set.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import pino from 'pino';
import { ParakeetLiveRecognizer, type LiveEvent } from '../src/audio/parakeet-live.js';
import { pcmFromWav } from '../src/audio/smartTurn.js';

const modelDir = process.env['PARAKEET_STREAMING_MODEL_DIR'];
const wavPath = process.env['PARAKEET_TEST_WAV'];

describe.skipIf(!modelDir || !wavPath)('Parakeet live (real streaming model)', () => {
  test('words arrive as chunks are fed, a pause ends the phrase, and the worker is reused', async () => {
    const rec = new ParakeetLiveRecognizer({ logger: pino({ level: 'silent' }), modelDir });
    await rec.warm();
    const speech = pcmFromWav(readFileSync(wavPath!));
    for (let round = 0; round < 2; round++) {
      const events: LiveEvent[] = [];
      const s = rec.open((e) => events.push(e));
      const cpu0 = process.cpuUsage();
      const wall0 = Date.now();
      // speech, 1.2 s of silence, speech again; fed in 100 ms chunks
      const audio = new Int16Array(speech.length * 2 + 19200);
      audio.set(speech, 0);
      audio.set(speech, speech.length + 19200);
      for (let i = 0; i < audio.length; i += 1600) s.accept(audio.subarray(i, i + 1600));
      await s.finish();
      const cpu = process.cpuUsage(cpu0);
      console.log(
        `round ${round}: ${(audio.length / 16000).toFixed(1)}s audio, cpu ${Math.round((cpu.user + cpu.system) / 1000)}ms, wall ${Date.now() - wall0}ms`,
      );
      const phrases = events.filter((e) => e.type === 'phrase');
      expect(events.filter((e) => e.type === 'error')).toEqual([]);
      expect(phrases.length).toBe(2);
      for (const p of phrases) {
        if (p.type !== 'phrase') continue;
        expect(p.text).toMatch(/ask not what your country/i);
      }
      const [a, b] = phrases as Array<Extract<LiveEvent, { type: 'phrase' }>>;
      expect(a!.endSample).toBeLessThanOrEqual(b!.startSample);
      expect(b!.endSample).toBeLessThanOrEqual(audio.length);
      s.close();
    }
    await rec.close();
  }, 120000);
});
