import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KOKORO_MODEL,
  KOKORO_VOICES,
  KOKORO_WARM_INTERVAL_MS,
  LocalTtsController,
  SherpaKokoroEngine,
  type KokoroEngine,
} from './local-tts';
import { LocalSttController } from './local-stt-controller';
import { LOCAL_STT_MODELS } from './local-stt-models';

function install(dir: string, models: readonly { dir: string; files: readonly string[] }[]): void {
  for (const m of models) {
    mkdirSync(join(dir, m.dir), { recursive: true });
    for (const f of m.files) writeFileSync(join(dir, m.dir, f), 'x');
  }
}

function fakeEngine(): KokoroEngine & { calls: [string, string, number][] } {
  const calls: [string, string, number][] = [];
  return {
    calls,
    synthesize: async (text, voice, speed) => {
      calls.push([text, voice, speed]);
      return new Int16Array([1, 2, 3]);
    },
    close: async () => {},
  };
}

test('Kokoro not downloaded: speaking names what is missing and where to get it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kokoro-'));
  try {
    const c = new LocalTtsController({ modelsDir: dir, makeEngine: () => fakeEngine() });
    assert.equal(c.status().installed, false);
    assert.equal(c.status().downloadBytes, KOKORO_MODEL.bytes);
    await assert.rejects(
      c.speak('hi', 'af_heart', 1),
      /Kokoro on this computer is not downloaded .*Settings → Voice calls/,
    );
    await c.warm(); // nothing to warm, nothing thrown
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kokoro speaks with the chosen voice and speed, and stays warm only while idle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kokoro-'));
  install(dir, [KOKORO_MODEL]);
  let now = 1_000;
  const engine = fakeEngine();
  try {
    const c = new LocalTtsController({ modelsDir: dir, makeEngine: () => engine, now: () => now });
    assert.deepEqual(c.status().voices, KOKORO_VOICES);
    await c.warm();
    assert.equal(engine.calls.length, 1);
    assert.deepEqual([...(await c.speak('Done.', 'bm_george', 1.2))], [1, 2, 3]);
    assert.deepEqual(engine.calls[1], ['Done.', 'bm_george', 1.2]);
    now += KOKORO_WARM_INTERVAL_MS - 1;
    await c.warm();
    assert.equal(engine.calls.length, 2, 'recently used: no warm-up');
    now += 2;
    await c.warm();
    assert.equal(engine.calls.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown Kokoro voice is refused by name', async () => {
  const e = new SherpaKokoroEngine({ sherpa: 'unused', dir: 'unused' });
  await assert.rejects(e.synthesize('hi', 'xx_nobody', 1), /Kokoro has no voice "xx_nobody"/);
});

test('Parakeet reads one utterance with the accurate model, or says what is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parakeet-'));
  const reads: number[] = [];
  try {
    const c = new LocalSttController({
      modelsDir: dir,
      engines: () => ({
        live: {
          open: () => {
            throw new Error('not used');
          },
        },
        accurate: { transcribe: async (pcm) => (reads.push(pcm.length), 'hello') },
      }),
    });
    await assert.rejects(c.read(new Int16Array(4)), /Parakeet on this computer is not downloaded/);
    install(dir, LOCAL_STT_MODELS);
    assert.equal(await c.read(new Int16Array(4)), 'hello');
    assert.deepEqual(reads, [4]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
