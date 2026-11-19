// spec/16 § Who is speaking — voiceprints for enrolment, and the speaker model.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { voiceSimilarity } from '@patch/wire';
import { handleVoiceprintRequest } from '../src/voiceprints.js';
import {
  RecentVoices,
  SpeakerId,
  SpeakerIdUnavailableError,
  TooShortError,
} from '../src/audio/speakerId.js';
import { MicTape } from '../src/audio/deviceVoice.js';

const logger = pino({ level: 'silent' });
const unit = (i: number): number[] => Array.from({ length: 256 }, (_, j) => (j === i ? 1 : 0));

async function ask(
  event: Extract<WireEvent, { type: 'patch.voiceprint.request' }>,
  embed: (pcm: Int16Array) => Promise<number[]>,
  recent = new RecentVoices(),
): Promise<Extract<WireEvent, { type: 'patch.voiceprint.response' }>> {
  const sent: WireEvent[] = [];
  await handleVoiceprintRequest(event, (e) => sent.push(e), logger, 'host-a', {
    speakerId: { embed },
    recent,
  });
  expect(sent).toHaveLength(1);
  return sent[0] as Extract<WireEvent, { type: 'patch.voiceprint.response' }>;
}

describe('voiceprint requests', () => {
  const pcm = Buffer.from(new Int16Array(32000).fill(100).buffer).toString('base64');

  it('turns a sample into a voiceprint', async () => {
    const res = await ask(
      { type: 'patch.voiceprint.request', requestId: 'r1', hostId: 'host-a', op: 'embed', pcm },
      async () => unit(3),
    );
    expect(res.ok).toBe(true);
    expect(res.voiceprint?.[3]).toBe(1);
    expect(res.seconds).toBe(2);
  });

  it('names a sample too short, and a host with no speaker model', async () => {
    const short = await ask(
      { type: 'patch.voiceprint.request', requestId: 'r1', hostId: 'host-a', op: 'embed', pcm },
      async () => {
        throw new TooShortError('too short');
      },
    );
    expect(short.error?.code).toBe('too_short');
    const missing = await ask(
      { type: 'patch.voiceprint.request', requestId: 'r2', hostId: 'host-a', op: 'embed', pcm },
      async () => {
        throw new SpeakerIdUnavailableError('install it');
      },
    );
    expect(missing).toMatchObject({ ok: false, error: { code: 'voice_component_missing' } });
  });

  it('lists the voices heard lately, newest first', async () => {
    const recent = new RecentVoices(2);
    recent.add({ at: 1, text: 'one', seconds: 2, voiceprint: unit(0), score: 0 });
    recent.add({ at: 2, text: 'two', seconds: 2, voiceprint: unit(1), score: 0 });
    recent.add({ at: 3, text: 'three', seconds: 2, voiceprint: unit(2), score: 0 });
    const res = await ask(
      { type: 'patch.voiceprint.request', requestId: 'r3', hostId: 'host-a', op: 'recent' },
      async () => unit(0),
      recent,
    );
    expect(res.recent?.map((v) => v.text)).toEqual(['three', 'two']);
  });
});

describe('MicTape', () => {
  it('cuts an utterance out by milliseconds, across the wrap', () => {
    const tape = new MicTape(1);
    for (let i = 0; i < 30; i++) tape.push(new Int16Array(1600).fill(i)); // 3 s into a 1 s tape
    const cut = tape.slice(2500, 2700);
    expect(cut.length).toBe(3200);
    expect(cut[0]).toBe(25);
    expect(cut[cut.length - 1]).toBe(26);
    // Older than the tape holds: clipped to what is left.
    expect(tape.slice(0, 2100).length).toBe(1600);
  });
});

// The real model, when one is on disk (SPEAKER_MODEL_PATH): the same voice
// must score far above a different one. Uses macOS's `say` for two voices.
const MODEL = process.env.SPEAKER_MODEL_PATH;
const canSay = process.platform === 'darwin';
describe.skipIf(!MODEL || !existsSync(MODEL) || !canSay)('the speaker model', () => {
  function voice(name: string, text: string): Int16Array {
    const dir = mkdtempSync(join(tmpdir(), 'spk-'));
    const out = join(dir, 'v.wav');
    execFileSync('say', ['-v', name, '-o', out, '--data-format=LEI16@16000', text]);
    const wav = readFileSync(out);
    const data = wav.subarray(wav.indexOf('data') + 8);
    return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.length & ~1)));
  }

  it('tells two voices apart off the main thread', async () => {
    const id = new SpeakerId({ logger, modelPath: () => MODEL });
    try {
      expect(id.available()).toBe(true);
      const a1 = await id.embed(
        voice('Daniel', 'Hello, this is me talking to the speaker in the kitchen.'),
      );
      const a2 = await id.embed(voice('Daniel', 'What time does the next train leave tomorrow?'));
      const b1 = await id.embed(
        voice('Moira', 'Hello, this is me talking to the speaker in the kitchen.'),
      );
      expect(a1).toHaveLength(256);
      expect(voiceSimilarity(a1, a2)).toBeGreaterThan(0.75);
      expect(voiceSimilarity(a1, b1)).toBeLessThan(0.6);
      await expect(id.embed(new Int16Array(8000))).rejects.toBeInstanceOf(TooShortError);
    } finally {
      await id.close();
    }
  }, 60_000);
});
