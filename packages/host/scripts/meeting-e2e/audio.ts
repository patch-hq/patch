// Voices the scripted call with Kokoro and writes the two recordings the run plays:
//   call.wav  what the call app would play (Priya, Marcus, hold music, silence), read by
//             `patch-audio tap` in file mode
//   mic.wav   what the owner's microphone hears, fed to Chromium's fake capture device
// Both are 16 kHz mono 16-bit, the format the helper and the web capture work in.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { createKokoro } from '../../src/audio/kokoro.js';
import {
  KOKORO_MODEL,
  KOKORO_SIDECAR,
  SAMPLE_RATE,
  resample,
  synth,
  wav,
} from '../../test/helpers/syntheticCall.js';
import { layout, MIC_HEAD_SECONDS, SCRIPT, type Timeline, type Who } from './scenario.js';

/** Priya is the voice as it comes; Marcus and the owner are shifted so no two sound alike. */
const PITCH: Record<Who, number> = { priya: 1, marcus: 0.78, owner: 0.9 };
const VOICE = 'af_heart';
/** Hold music sits well above the silence floor: it is exactly what Whisper hears words in. */
const MUSIC_GAIN = 0.12;

const seconds = (n: number): number => Math.round(n * SAMPLE_RATE);

async function voiceLines(): Promise<Int16Array[]> {
  const kokoro = createKokoro({
    backend: 'real',
    logger: pino({ level: 'silent' }),
    modelPath: KOKORO_MODEL,
    sidecarCwd: KOKORO_SIDECAR,
  });
  try {
    const out: Int16Array[] = [];
    for (const step of SCRIPT) {
      if (step.kind !== 'line') continue;
      let pcm = await synth(kokoro, step.text, VOICE);
      const shift = PITCH[step.who];
      if (shift !== 1) pcm = resample(pcm, SAMPLE_RATE * shift, SAMPLE_RATE);
      const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      if (peak < 1000) throw new Error(`kokoro returned silence for "${step.text.slice(0, 40)}"`);
      out.push(pcm);
    }
    return out;
  } finally {
    await kokoro.close();
  }
}

/** A slow chord progression: a few sine voices with a soft envelope, no speech in it. */
export function music(sec: number): Int16Array {
  const out = new Int16Array(seconds(sec));
  const chords = [
    [220, 277.18, 329.63],
    [196, 246.94, 293.66],
    [174.61, 220, 261.63],
    [196, 246.94, 392],
  ];
  const chordLen = 2.5;
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const chord = chords[Math.floor(t / chordLen) % chords.length]!;
    const phase = (t % chordLen) / chordLen;
    const env = Math.min(1, phase * 8) * Math.min(1, (1 - phase) * 4);
    let v = 0;
    for (const f of chord) v += Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t);
    out[i] = Math.round((v / (chord.length * 1.3)) * env * MUSIC_GAIN * 0x7fff);
  }
  return out;
}

export interface BuiltCall {
  timeline: Timeline;
  callWav: string;
  micWav: string;
}

export async function buildScenarioAudio(dir: string): Promise<BuiltCall> {
  const pcms = await voiceLines();
  const timeline = layout(
    SCRIPT,
    pcms.map((p) => p.length / SAMPLE_RATE),
  );
  const total = seconds(timeline.totalSeconds + 2);
  const call = new Int16Array(total);
  const mic = new Int16Array(total);
  const put = (track: Int16Array, at: number, pcm: Int16Array): void => {
    const start = seconds(at);
    for (let i = 0; i < pcm.length && start + i < track.length; i++) track[start + i] = pcm[i]!;
  };
  timeline.lines.forEach((line, i) => {
    const pcm = pcms[i]!;
    if (line.who !== 'owner') return put(call, line.start, pcm);
    // The first owner line is the mic check: said at the head of the file, and again by
    // the re-opened microphone, which starts from the file's beginning.
    if (line.start < timeline.switchAt) return put(mic, line.start - 1 + 0.5, pcm);
    // After the switch the new stream's clock restarts, so the file is offset by it.
    const at = line.start - timeline.switchAt;
    if (at < MIC_HEAD_SECONDS)
      throw new Error('owner line overlaps the check line on the fresh mic');
    put(mic, at, pcm);
  });
  for (const s of timeline.stretches)
    if (s.kind === 'music') put(call, s.start, music(s.end - s.start));

  const callWav = join(dir, 'call.wav');
  const micWav = join(dir, 'mic.wav');
  writeFileSync(callWav, wav(call));
  writeFileSync(micWav, wav(mic));
  writeFileSync(join(dir, 'timeline.json'), JSON.stringify(timeline, null, 2));
  return { timeline, callWav, micWav };
}
