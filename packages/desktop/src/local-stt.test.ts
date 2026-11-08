// Unit tests for local dictation (local-stt.ts, local-stt-controller.ts, local-stt-models.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDictation, type LiveEvent, type LocalDictationEvent } from './local-stt';
import { LocalSttController } from './local-stt-controller';
import {
  LOCAL_STT_MODELS,
  downloadLocalSttModels,
  localSttMissingMessage,
  localSttStatus,
} from './local-stt-models';

function fakeLive() {
  let on: (ev: LiveEvent) => void = () => undefined;
  const fed: Int16Array[] = [];
  let finishImpl: () => Promise<void> = async () => undefined;
  return {
    engine: {
      open(cb: (ev: LiveEvent) => void) {
        on = cb;
        return {
          accept: (p: Int16Array) => fed.push(p),
          finish: () => finishImpl(),
          close: () => undefined,
        };
      },
    },
    emit: (ev: LiveEvent) => on(ev),
    fed,
    onFinish: (f: () => Promise<void>) => (finishImpl = f),
  };
}

test('live words show as they come, accurate reads replace them, the final is the accurate text', async () => {
  const live = fakeLive();
  const reads: Int16Array[] = [];
  const events: LocalDictationEvent[] = [];
  const d = new LocalDictation(
    live.engine,
    {
      transcribe: async (pcm) => {
        reads.push(pcm);
        return 'Hello, world.';
      },
    },
    (e) => events.push(e),
  );
  d.push(Int16Array.from([1, 2, 3, 4]));
  d.push(Int16Array.from([5, 6, 7, 8]));
  live.emit({ type: 'text', text: 'hello wor' });
  live.emit({ type: 'phrase', text: 'hello world', startSample: 2, endSample: 6 });
  const final = await d.finish();
  assert.equal(final, 'Hello, world.');
  assert.deepEqual([...reads[0]!], [3, 4, 5, 6]);
  assert.deepEqual(events[0], { type: 'partial', text: 'hello wor' });
  assert.deepEqual(events.at(-1), { type: 'partial', text: 'Hello, world.' });
});

test('a failed accurate read fails the dictation instead of keeping the live words', async () => {
  const live = fakeLive();
  const events: LocalDictationEvent[] = [];
  const d = new LocalDictation(
    live.engine,
    { transcribe: async () => Promise.reject(new Error('model gone')) },
    (e) => events.push(e),
  );
  d.push(Int16Array.from([1, 2]));
  live.emit({ type: 'phrase', text: 'hi', startSample: 0, endSample: 2 });
  await assert.rejects(d.finish(), /accurate read of a phrase failed: model gone/);
  assert.equal(events.at(-1)?.type, 'error');
});

test('a streaming engine error ends the dictation with its reason', async () => {
  const live = fakeLive();
  const events: LocalDictationEvent[] = [];
  const d = new LocalDictation(live.engine, { transcribe: async () => '' }, (e) => events.push(e));
  live.emit({ type: 'error', message: 'addon would not load' });
  await assert.rejects(d.finish(), /addon would not load/);
  assert.deepEqual(events, [
    { type: 'error', message: 'Live dictation failed: addon would not load' },
  ]);
});

function modelsDirWith(complete: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'patch-models-'));
  for (const m of LOCAL_STT_MODELS) {
    mkdirSync(join(dir, m.dir), { recursive: true });
    for (const f of m.files) if (complete) writeFileSync(join(dir, m.dir, f), '');
  }
  return dir;
}

test('status names what is missing and what the download costs', () => {
  const empty = mkdtempSync(join(tmpdir(), 'patch-models-'));
  const s = localSttStatus(empty);
  assert.equal(s.installed, false);
  assert.equal(s.missing.length, 8);
  assert.equal(
    s.downloadBytes,
    LOCAL_STT_MODELS.reduce((n, m) => n + m.bytes, 0),
  );
  assert.match(localSttMissingMessage(s), /not downloaded .*encoder\.int8\.onnx/);
  assert.equal(localSttStatus(modelsDirWith(true)).installed, true);
});

test('starting without the models is a clear error, never another engine', () => {
  const c = new LocalSttController({
    modelsDir: modelsDirWith(false),
    engines: () => {
      throw new Error('must not build engines');
    },
  });
  assert.throws(() => c.start(() => undefined), /Parakeet on this computer is not downloaded/);
});

test('the controller runs one dictation and finishes it', async () => {
  const live = fakeLive();
  const c = new LocalSttController({
    modelsDir: modelsDirWith(true),
    engines: () => ({ live: live.engine, accurate: { transcribe: async () => 'Done.' } }),
  });
  const events: LocalDictationEvent[] = [];
  c.start((e) => events.push(e));
  c.push(Int16Array.from([1, 2, 3]));
  live.emit({ type: 'phrase', text: 'done', startSample: 0, endSample: 3 });
  assert.equal(await c.finish(), 'Done.');
  await assert.rejects(c.finish(), /no local dictation is running/);
});

test('download fetches only missing models, unpacks and moves them into place', async () => {
  const dir = modelsDirWith(true);
  const missing = LOCAL_STT_MODELS[0]!;
  // knock out the first model
  const { rmSync } = await import('node:fs');
  rmSync(join(dir, missing.dir), { recursive: true });
  const urls: string[] = [];
  const progress: number[] = [];
  await downloadLocalSttModels(dir, (p) => progress.push(p.received), {
    fetchImpl: (async (url: string) => {
      urls.push(url);
      return new Response('archive-bytes');
    }) as never,
    extract: async (_archive, into) => {
      mkdirSync(join(into, missing.dir));
      for (const f of missing.files) writeFileSync(join(into, missing.dir, f), '');
    },
  });
  assert.deepEqual(urls, [missing.url]);
  assert.equal(localSttStatus(dir).installed, true);
  assert.equal(existsSync(join(dir, `.download-${missing.dir}`)), false);
  assert.equal(progress.at(-1), missing.bytes);
});

test('a download that unpacks incomplete leaves nothing that looks installed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patch-models-'));
  await assert.rejects(
    downloadLocalSttModels(dir, () => undefined, {
      fetchImpl: (async () => new Response('x')) as never,
      extract: async (_a, into) => {
        mkdirSync(join(into, LOCAL_STT_MODELS[0]!.dir));
      },
    }),
    /did not hold/,
  );
  assert.equal(localSttStatus(dir).installed, false);
});
