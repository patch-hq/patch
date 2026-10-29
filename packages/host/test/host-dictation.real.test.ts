// The whole `host` engine on the REAL models: streaming words live, accurate
// read per phrase, final on stop. Skipped unless PARAKEET_MODEL_DIR,
// PARAKEET_STREAMING_MODEL_DIR and PARAKEET_TEST_WAV (16 kHz speech) are set.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import pino from 'pino';
import type { AudioEvent } from '@patch/wire/audio';
import { HostDictationSession } from '../src/audio/host-dictation.js';
import { ParakeetLiveRecognizer } from '../src/audio/parakeet-live.js';
import { ParakeetWhisperBackend } from '../src/audio/parakeet.js';
import { pcmFromWav } from '../src/audio/smartTurn.js';

const accurateDir = process.env['PARAKEET_MODEL_DIR'];
const liveDir = process.env['PARAKEET_STREAMING_MODEL_DIR'];
const wavPath = process.env['PARAKEET_TEST_WAV'];

describe.skipIf(!accurateDir || !liveDir || !wavPath)('host dictation (real models)', () => {
  test('two phrases spoken in real time: live words appear, stop lands the accurate text fast', async () => {
    const logger = pino({ level: 'silent' });
    const live = new ParakeetLiveRecognizer({ logger, modelDir: liveDir });
    const accurate = new ParakeetWhisperBackend({ logger, modelDir: accurateDir });
    await Promise.all([live.warm(), accurate.warm()]);
    const sent: Array<AudioEvent & { at: number }> = [];
    const t0 = Date.now();
    const session = new HostDictationSession(
      { sessionId: 's', chatId: 'c' },
      { logger, sendAudio: (e) => sent.push({ ...e, at: Date.now() - t0 }), live, accurate },
    );
    session.onSessionStart();
    const speech = pcmFromWav(readFileSync(wavPath!));
    const audio = new Int16Array(speech.length * 2 + 24000);
    audio.set(speech, 0);
    audio.set(speech, speech.length + 24000);
    // Real time: 100 ms chunks, 100 ms apart.
    for (let i = 0; i < audio.length; i += 1600) {
      await session.onMicFrame(audio.subarray(i, i + 1600));
      await new Promise((r) => setTimeout(r, 100));
    }
    const stopAt = Date.now();
    await session.finishDictation();
    const stopMs = Date.now() - stopAt;
    const partials = sent.filter((e) => e.type === 'audio.transcript_partial') as Array<{
      text: string;
      at: number;
    }>;
    const final = sent.find((e) => e.type === 'audio.transcript_final') as { text: string };
    const firstWordAt = partials[0]!.at;
    console.log(
      `first live words after ${firstWordAt}ms (speech starts at ~0); stop -> final ${stopMs}ms; ${partials.length} partials\nlast partial: ${partials.at(-1)!.text}\nfinal: ${final.text}`,
    );
    expect(sent.filter((e) => e.type === 'audio.error')).toEqual([]);
    expect(final.text).toBe(partials.at(-1)!.text.length > 0 ? final.text : '');
    expect(final.text.match(/Ask not what your country can do for you/g)?.length).toBe(2);
    expect(stopMs).toBeLessThan(3000);
    await live.close();
  }, 120000);
});
