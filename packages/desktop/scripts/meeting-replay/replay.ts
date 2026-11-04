// Replay a recorded or generated meeting through the desktop app's real
// transcription path, with no call: the echo canceller the app runs on the mic,
// then the on-device Parakeet transcriber, paced like live audio.
//
//   pnpm --filter @patch/desktop meeting:replay <dir> [--speed 1] [--json out.json]
//
// <dir> holds mic.wav and/or system.wav (16 kHz mono PCM16), as written by
// generate.py or saved from a real meeting, and optionally truth.json. It prints
// every final line as it lands with how long after the speech ended it arrived,
// then, given truth.json, which lines went to the wrong side and which were missed.
//
// Models: PATCH_PARAKEET_DIR and PATCH_VAD_MODEL, or the app's own download dir.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  MeetingTranscriber,
  SAMPLE_RATE,
  type TranscriptText,
} from '../../src/meeting-transcriber';
import { meetingModelPaths } from '../../src/meeting-models';
import { EchoCanceller } from '../../../web/src/lib/echoCanceller';

const CHUNK = 4096;

function readWav(path: string): Int16Array {
  const b = readFileSync(path);
  let o = 12;
  while (o < b.length) {
    const id = b.toString('ascii', o, o + 4);
    const size = b.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      const rate = b.readUInt32LE(o + 12);
      const channels = b.readUInt16LE(o + 10);
      if (rate !== SAMPLE_RATE || channels !== 1) {
        throw new Error(`${path} must be 16 kHz mono PCM16, is ${rate} Hz x${channels}`);
      }
    }
    if (id === 'data') {
      return new Int16Array(b.buffer.slice(b.byteOffset + o + 8, b.byteOffset + o + 8 + size));
    }
    o += 8 + size;
  }
  throw new Error(`${path} has no data chunk`);
}

interface Landed extends TranscriptText {
  /** Audio-clock seconds the line arrived, and how long after its speech ended. */
  landedAt: number;
  lagSeconds: number;
}

interface Truth {
  local: string;
  lines: { speaker: string; text: string; start: number; end: number }[];
}

const words = (t: string): string[] =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

function overlap(a: string, b: string): number {
  const wa = words(a);
  const wb = new Set(words(b));
  return wa.length === 0 ? 0 : wa.filter((w) => wb.has(w)).length / wa.length;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) throw new Error('usage: meeting-replay <dir> [--speed N] [--json out.json] [--no-aec]');
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const speed = Number(flag('--speed') ?? '1');
  const useAec = !args.includes('--no-aec');
  const mic = existsSync(join(dir, 'mic.wav')) ? readWav(join(dir, 'mic.wav')) : null;
  const system = existsSync(join(dir, 'system.wav')) ? readWav(join(dir, 'system.wav')) : null;
  if (!mic && !system) throw new Error(`${dir} has neither mic.wav nor system.wav`);

  const paths = meetingModelPaths(process.env['PATCH_MODELS_DIR']);
  const parakeetDir = process.env['PATCH_PARAKEET_DIR'] ?? paths.parakeetDir;
  const vadModel = process.env['PATCH_VAD_MODEL'] ?? paths.vadModel;

  // The replay keeps its own clock: audio time, in ms, from the first sample.
  const t0 = Date.now();
  const audioNow = (): number => (Date.now() - t0) * speed;
  const landed: Landed[] = [];
  const transcriber = new MeetingTranscriber({
    parakeetDir,
    vadModel,
    onText: (t) => {
      if (!t.final) return;
      const landedAt = audioNow() / 1000;
      const line = { ...t, landedAt, lagSeconds: landedAt - t.endedAt / 1000 };
      landed.push(line);
      console.log(
        `${landedAt.toFixed(1).padStart(6)}s  +${line.lagSeconds.toFixed(1)}s  ${t.source === 'mic' ? 'you ' : 'them'}  ${t.text}`,
      );
    },
    onError: (err) => {
      console.error(`transcription failed: ${err.message}`);
      process.exitCode = 1;
    },
  });

  const aec = useAec && mic && system ? new EchoCanceller() : null;
  const length = Math.max(mic?.length ?? 0, system?.length ?? 0);
  for (let i = 0; i < length; i += CHUNK) {
    const due = ((i + CHUNK) / SAMPLE_RATE) * 1000;
    const wait = due / speed - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const at = due;
    if (system) {
      const far = system.slice(i, i + CHUNK);
      aec?.pushFar(far);
      if (far.length > 0) transcriber.push('system', far, at);
    }
    if (mic) {
      const raw = mic.slice(i, i + CHUNK);
      const clean = aec ? aec.processMic(raw) : raw;
      if (clean.length > 0) transcriber.push('mic', clean, at);
    }
  }
  if (aec) transcriber.push('mic', aec.flush(), (length / SAMPLE_RATE) * 1000);
  await transcriber.close();

  const lags = landed.map((l) => l.lagSeconds).sort((a, b) => a - b);
  const pct = (p: number): number =>
    lags[Math.min(lags.length - 1, Math.floor(p * lags.length))] ?? 0;
  console.log(
    `\n${landed.length} lines. Lag after speech ended: median ${pct(0.5).toFixed(1)}s, worst ${(lags.at(-1) ?? 0).toFixed(1)}s`,
  );

  const truthFile = join(dir, 'truth.json');
  if (existsSync(truthFile)) {
    const truth = JSON.parse(readFileSync(truthFile, 'utf8')) as Truth;
    let missed = 0;
    let wrongSide = 0;
    for (const t of truth.lines) {
      const side = t.speaker === truth.local ? 'mic' : 'system';
      const near = landed.filter(
        (l) => l.endedAt / 1000 > t.start - 1 && l.startedAt / 1000 < t.end + 1,
      );
      const right = near
        .filter((l) => l.source === side)
        .map((l) => l.text)
        .join(' ');
      const wrong = near
        .filter((l) => l.source !== side)
        .map((l) => l.text)
        .join(' ');
      if (overlap(t.text, right) < 0.6) {
        missed++;
        console.log(`MISSED   ${t.speaker}: ${t.text}\n         heard: ${right || '(nothing)'}`);
      }
      if (wrong !== '' && overlap(wrong, t.text) >= 0.5) {
        wrongSide++;
        console.log(
          `WRONG    ${t.speaker} also heard as ${side === 'mic' ? 'them' : 'you'}: ${wrong}`,
        );
      }
    }
    // A line is right only if it matches something said on its own side.
    const invented = landed.filter(
      (l) =>
        !truth.lines.some(
          (t) =>
            (t.speaker === truth.local ? 'mic' : 'system') === l.source &&
            l.endedAt / 1000 > t.start - 2 &&
            l.startedAt / 1000 < t.end + 2 &&
            overlap(l.text, t.text) >= 0.5,
        ),
    );
    for (const l of invented)
      console.log(`INVENTED ${l.source === 'mic' ? 'you ' : 'them'}: ${l.text}`);
    console.log(
      `${truth.lines.length} turns: ${missed} missed, ${wrongSide} on the wrong side, ${invented.length} lines not said on that side`,
    );
  }
  const out = flag('--json');
  if (out) writeFileSync(out, JSON.stringify(landed, null, 1));
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
