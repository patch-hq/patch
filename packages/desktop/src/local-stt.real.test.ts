// Runs the REAL sherpa-onnx engines. Skipped unless LOCAL_STT_MODELS_DIR (holding both
// model folders) and LOCAL_STT_WAV (a 16 kHz mono PCM16 speech clip) are set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { LocalDictation, type LocalDictationEvent } from './local-stt';
import { modelDir } from './local-stt-models';
import { SherpaAccurateEngine, SherpaLiveEngine } from './local-stt-workers';

const models = process.env['LOCAL_STT_MODELS_DIR'];
const wav = process.env['LOCAL_STT_WAV'];

test('real models: speech in, accurate words out', { skip: !models || !wav }, async () => {
  const file = readFileSync(wav!);
  const speech = new Int16Array(
    file.buffer,
    file.byteOffset + 44,
    Math.floor((file.length - 44) / 2),
  );
  const o = {
    sherpa: createRequire(__filename).resolve('sherpa-onnx-node'),
    liveDir: modelDir(models!, 'live'),
    accurateDir: modelDir(models!, 'accurate'),
  };
  const accurate = new SherpaAccurateEngine(o);
  const events: LocalDictationEvent[] = [];
  const d = new LocalDictation(new SherpaLiveEngine(o), accurate, (e) => events.push(e));
  const audio = new Int16Array(speech.length + 16000);
  audio.set(speech, 0);
  for (let i = 0; i < audio.length; i += 1600) d.push(audio.subarray(i, i + 1600));
  const final = await d.finish();
  d.cancel();
  await accurate.close();
  console.log('final:', final);
  assert.ok(events.some((e) => e.type === 'partial'));
  assert.ok(final.length > 10);
});
