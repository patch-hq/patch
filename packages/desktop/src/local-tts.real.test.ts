// Runs the REAL Kokoro through sherpa-onnx. Skipped unless KOKORO_MODELS_DIR holds
// the unpacked `kokoro-int8-multi-lang-v1_0` folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { KOKORO_MODEL, SherpaKokoroEngine } from './local-tts';

const models = process.env['KOKORO_MODELS_DIR'];

test('real Kokoro: text in, 24 kHz speech out', { skip: !models }, async () => {
  const engine = new SherpaKokoroEngine({
    sherpa: createRequire(__filename).resolve('sherpa-onnx-node'),
    dir: join(models!, KOKORO_MODEL.dir),
  });
  try {
    const us = await engine.synthesize('The tests pass now.', 'af_heart', 1);
    const gb = await engine.synthesize('The tests pass now.', 'bm_george', 1.1);
    // About a second of speech at 24 kHz, and not silence.
    assert.ok(us.length > 12_000, `only ${us.length} samples`);
    assert.ok(gb.length > 12_000);
    assert.ok(us.some((s) => Math.abs(s) > 1000));
  } finally {
    await engine.close();
  }
});
