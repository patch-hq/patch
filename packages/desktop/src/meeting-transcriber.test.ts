import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MeetingTranscriber,
  PARAKEET_FILES,
  SAMPLE_RATE,
  isEchoOf,
  type SherpaModule,
  type TranscriptText,
} from './meeting-transcriber';

test('a mic line made of words the call said at the same moment is its echo', () => {
  assert.equal(isEchoOf('Found it.', ['I found it. The session cookie was being set']), true);
  assert.equal(isEchoOf("That's it.", ["No, that's it from me."]), true);
  assert.equal(isEchoOf('Marco, what about the login bug?', ['Yes, I think so.']), false);
  assert.equal(isEchoOf('', ['anything']), false);
});

/** A fake sherpa: the VAD calls a window speech when its first sample is non-zero. */
function fakeSherpa(): SherpaModule {
  class Vad {
    private segs: { samples: Float32Array; start: number }[] = [];
    private cur: number[] = [];
    private start = 0;
    private fed = 0;
    acceptWaveform(w: Float32Array): void {
      if (w[0] !== 0) {
        if (this.cur.length === 0) this.start = this.fed;
        this.cur.push(...w);
      } else if (this.cur.length > 0) this.close();
      this.fed += w.length;
    }
    private close(): void {
      this.segs.push({ samples: Float32Array.from(this.cur), start: this.start });
      this.cur = [];
    }
    isEmpty(): boolean {
      return this.segs.length === 0;
    }
    isDetected(): boolean {
      return this.cur.length > 0;
    }
    front(): { samples: Float32Array; start: number } {
      return this.segs[0]!;
    }
    pop(): void {
      this.segs.shift();
    }
    flush(): void {
      if (this.cur.length > 0) this.close();
    }
  }
  // The "recogniser" reads the sample value as a word: 0.1 → said[1].
  const said = ['', 'found it', 'i found it and fixed the cookie', 'agreed ship it'];
  class OfflineRecognizer {
    createStream(): { samples?: Float32Array; acceptWaveform(w: { samples: Float32Array }): void } {
      return {
        acceptWaveform(w) {
          this.samples = w.samples;
        },
      };
    }
    async decodeAsync(s: { samples?: Float32Array }): Promise<{ text: string }> {
      const i = Math.round((s.samples?.[0] ?? 0) * 10);
      return { text: said[i] ?? '' };
    }
  }
  return { Vad, OfflineRecognizer } as unknown as SherpaModule;
}

function models(): { parakeetDir: string; vadModel: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mt-'));
  for (const f of PARAKEET_FILES) writeFileSync(join(dir, f), '');
  writeFileSync(join(dir, 'vad.onnx'), '');
  return { parakeetDir: dir, vadModel: join(dir, 'vad.onnx') };
}

const tone = (value: number, seconds: number): Int16Array =>
  new Int16Array(Math.round(seconds * SAMPLE_RATE)).fill(Math.round(value * 32768));

test('cuts at pauses, times lines on the wall clock, and drops the echo of the call from the mic', async () => {
  const out: TranscriptText[] = [];
  const t = new MeetingTranscriber({
    ...models(),
    loadSherpa: fakeSherpa,
    onText: (x) => {
      if (x.final) out.push(x);
    },
    onError: (e) => assert.fail(e),
  });
  const origin = 1_000_000;
  // Second 0-1: the call says "i found it..." while the mic hears its echo "found it".
  t.push('system', tone(0.2, 1), origin + 1000);
  t.push('mic', tone(0.1, 1), origin + 1000);
  // Second 1-2: quiet on both. Second 2-3: the mic says something of its own.
  t.push('system', tone(0, 2), origin + 3000);
  t.push('mic', tone(0, 1), origin + 2000);
  t.push('mic', tone(0.3, 1), origin + 3000);
  t.push('mic', tone(0, 1), origin + 4000);
  await t.close();
  assert.deepEqual(
    out.map((x) => [x.source, x.text, Math.round((x.startedAt - origin) / 100) * 100]),
    [
      ['system', 'i found it and fixed the cookie', 0],
      ['mic', 'agreed ship it', 2000],
    ],
  );
});

test('a missing model is an error naming the file, not a silent mic-only meeting', () => {
  assert.throws(
    () =>
      new MeetingTranscriber({
        parakeetDir: '/nowhere',
        vadModel: '/nowhere/vad.onnx',
        onText: () => undefined,
        onError: () => undefined,
        loadSherpa: fakeSherpa,
      }),
    /encoder\.int8\.onnx/,
  );
});
