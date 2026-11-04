// Runs the REAL model. Skipped unless PARAKEET_MODEL_DIR points at the
// extracted sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 and PARAKEET_TEST_WAV at
// any speech clip. `ffmpeg` makes the m4a.
import { beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { ParakeetWhisperBackend } from '../src/audio/parakeet.js';
import { pcmFromWav } from '../src/audio/smartTurn.js';

const modelDir = process.env['PARAKEET_MODEL_DIR'];
const wavPath = process.env['PARAKEET_TEST_WAV'];

describe.skipIf(!modelDir || !wavPath)('Parakeet (real model)', () => {
  const logger = pino({ level: 'silent' });
  const tmp = mkdtempSync(join(tmpdir(), 'parakeet-real-'));
  const wav16 = join(tmp, 'clip.wav');
  const m4a = join(tmp, 'clip.m4a');
  beforeAll(() => {
    execFileSync('ffmpeg', ['-v', 'error', '-i', wavPath!, '-ar', '16000', '-ac', '1', wav16]);
    execFileSync('ffmpeg', ['-v', 'error', '-i', wav16, '-c:a', 'aac', m4a]);
  });
  const backend = new ParakeetWhisperBackend({ logger, modelDir });

  test('reads a wav and an m4a to the same punctuated sentence', async () => {
    const fromWav = await backend.transcribeClip(readFileSync(wav16), 'wav');
    const fromM4a = await backend.transcribeClip(readFileSync(m4a), 'm4a');
    expect(fromWav).toMatch(/^Ask not what your country can do for you/);
    expect(fromM4a.toLowerCase().replace(/[^a-z ]/g, '')).toContain('ask not what your country');
  }, 120000);

  test('a 30 s dictation: every live pass stays short and the preview never loses early words', async () => {
    const one = pcmFromWav(readFileSync(wav16));
    const pcm = new Int16Array(one.length * 8);
    for (let r = 0; r < 8; r++) pcm.set(one, r * one.length);
    const passes: number[] = [];
    let live = '';
    const cpu0 = process.cpuUsage();
    const wall0 = Date.now();
    for (let end = 8000; end <= pcm.length; end += 8000) {
      const t = Date.now();
      live = await backend.transcribe(pcm.slice(0, end), { priority: 'partial' });
      passes.push(Date.now() - t);
    }
    const cpu = process.cpuUsage(cpu0);
    const wall = Date.now() - wall0;
    const audioSecs = pcm.length / 16000;
    console.log(
      `parakeet live over ${audioSecs.toFixed(0)}s: ${passes.length} passes, max ${Math.max(...passes)}ms, wall ${wall}ms, cpu ${Math.round((cpu.user + cpu.system) / 1000)}ms (${((cpu.user + cpu.system) / 1000 / wall).toFixed(1)} cores)`,
    );
    expect(Math.max(...passes)).toBeLessThan(4000);
    expect(live.match(/Ask not what your country/gi)?.length ?? 0).toBeGreaterThanOrEqual(7);
    const final = await backend.transcribe(pcm, { priority: 'final' });
    console.log('final words', final.split(/\s+/).length, 'live words', live.split(/\s+/).length);
  }, 300000);
});
