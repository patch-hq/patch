// Builds a two-voice call as real audio: a system-audio track (the remote
// people) and a mic track (the owner, with the call bleeding in at low volume),
// both 16 kHz mono PCM16, cut into the clips a surface sends.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { createKokoro } from '../../src/audio/kokoro.js';

export const KOKORO_MODEL = join(homedir(), '.patch', 'components', 'kokoro');
export const KOKORO_SIDECAR = join(__dirname, '..', '..', '..', 'kokoro-sidecar');
export const SAMPLE_RATE = 16_000;

export interface ScriptLine {
  who: 'you' | 'them';
  voice: string;
  text: string;
}

/** Distinct sentences so a transcript line can be matched back to the one that was spoken. */
// Voice: only af_heart is installed on this host; the remote side is pitch-shifted in buildCall.
export const CALL_SCRIPT: ScriptLine[] = [
  {
    who: 'them',
    voice: 'af_heart',
    text: 'Morning Tom, thanks for joining. I wanted to talk about the invoice export before the Friday release.',
  },
  {
    who: 'you',
    voice: 'af_heart',
    text: 'Morning Priya. The export is working in staging, but the currency rounding still looks wrong on euro totals.',
  },
  {
    who: 'them',
    voice: 'af_heart',
    text: 'Understood. Can you send me three failing examples by tomorrow lunchtime so I can raise it with finance?',
  },
  {
    who: 'you',
    voice: 'af_heart',
    text: 'Yes, I will email the examples to you tomorrow morning, and I will also add a regression test for rounding.',
  },
  {
    who: 'them',
    voice: 'af_heart',
    text: 'Great. Separately, the Bristol office move has been pushed back to the end of January, so nobody needs to pack yet.',
  },
  {
    who: 'you',
    voice: 'af_heart',
    text: 'Good to know. I will tell the platform team that the move is delayed and the laptops stay where they are.',
  },
  {
    who: 'them',
    voice: 'af_heart',
    text: 'Last thing, please book the retrospective for next Wednesday afternoon, and invite the design team as well.',
  },
  {
    who: 'you',
    voice: 'af_heart',
    text: 'Will do. I will book the retrospective for Wednesday at two and send the invitation this afternoon.',
  },
];

export function kokoroAvailable(): boolean {
  return existsSync(KOKORO_MODEL) && existsSync(KOKORO_SIDECAR);
}

/** 24 kHz → 16 kHz by linear interpolation. */
export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  const n = Math.floor((pcm.length * to) / from);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const pos = (i * from) / to;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = pcm[i0] ?? 0;
    const b = pcm[Math.min(i0 + 1, pcm.length - 1)] ?? 0;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

export async function synth(
  kokoro: ReturnType<typeof createKokoro>,
  text: string,
  voice: string,
): Promise<Int16Array> {
  const s = await kokoro.synthesize(text, voice);
  const parts: Int16Array[] = [];
  for await (const c of s.iterator) parts.push(Int16Array.from(c.pcm));
  const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return resample(all, 24_000, SAMPLE_RATE);
}

export function wav(pcm: Int16Array): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  return Buffer.concat([h, data]);
}

export interface SyntheticCall {
  system: Int16Array;
  mic: Int16Array;
  durationMs: number;
}

/**
 * Turns alternate. System carries the remote voice and silence while the owner
 * talks; mic carries the owner, plus the remote voice at `bleed` gain.
 */
export async function buildCall(script: ScriptLine[], bleed = 0.3): Promise<SyntheticCall> {
  const kokoro = createKokoro({
    backend: 'real',
    logger: pino({ level: 'silent' }),
    modelPath: KOKORO_MODEL,
    sidecarCwd: KOKORO_SIDECAR,
  });
  try {
    const gap = new Int16Array(Math.round(SAMPLE_RATE * 0.8));
    const spoken: Int16Array[] = [];
    for (const l of script) {
      let pcm = await synth(kokoro, l.text, l.voice);
      // Only af_heart is installed on this host, and a missing voice comes back as
      // silence. The remote speaker is the same voice resampled down ~20%: slower
      // and deeper, enough for a different-sounding person.
      if (l.who === 'them') pcm = resample(pcm, SAMPLE_RATE * 0.8, SAMPLE_RATE);
      const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      if (peak < 1000) throw new Error(`kokoro returned silence for "${l.text.slice(0, 40)}"`);
      spoken.push(pcm);
    }
    const total = spoken.reduce((n, s) => n + s.length + gap.length, 0);
    const system = new Int16Array(total);
    const mic = new Int16Array(total);
    let at = 0;
    script.forEach((l, i) => {
      const s = spoken[i]!;
      for (let k = 0; k < s.length; k++) {
        if (l.who === 'them') {
          system[at + k] = s[k]!;
          mic[at + k] = Math.round(s[k]! * bleed);
        } else mic[at + k] = s[k]!;
      }
      at += s.length + gap.length;
    });
    return { system, mic, durationMs: (total / SAMPLE_RATE) * 1000 };
  } finally {
    await kokoro.close();
  }
}

export function clips(track: Int16Array, seconds: number): Int16Array[] {
  const size = seconds * SAMPLE_RATE;
  const out: Int16Array[] = [];
  for (let i = 0; i < track.length; i += size) out.push(track.subarray(i, i + size));
  return out;
}
