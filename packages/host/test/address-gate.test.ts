// The address gate in front of Gemini Live (src/audio/address-gate.ts): which
// utterances reach the model, and which never leave the host.

import { describe, test, expect } from 'vitest';
import { AddressGate, type AddressGateDeps } from '../src/audio/address-gate.js';
import { MockVad } from '../src/audio/vad.js';
import type { WhisperBackend } from '../src/audio/whisper.js';

const FRAME = 512; // 32 ms at 16 kHz
const loud = (): Int16Array => new Int16Array(FRAME).fill(8000);
const quiet = (): Int16Array => new Int16Array(FRAME);

function transcriber(text: string | Error): WhisperBackend {
  return {
    supportsLivePartials: false,
    transcribe: async () => {
      if (text instanceof Error) throw text;
      return text;
    },
    transcribeClip: async () => text as string,
    close: async () => {},
  };
}

function rig(opts: {
  text?: string | Error;
  requiresAddress?: boolean;
  msSinceSpoke?: number | undefined;
}) {
  const out: string[] = [];
  const unaddressed: string[] = [];
  const errors: string[] = [];
  const deps: AddressGateDeps = {
    vad: new MockVad(),
    transcriber: transcriber(opts.text ?? ''),
    addressWord: () => 'patch',
    requiresAddress: () => opts.requiresAddress ?? true,
    msSinceSpoke: () => opts.msSinceSpoke,
    endSilenceMs: 1000,
    activityStart: () => out.push('start'),
    audio: () => out.push('audio'),
    activityEnd: () => out.push('end'),
    unaddressed: (t) => unaddressed.push(t),
    onError: (e) => errors.push(e.message),
  };
  const gate = new AddressGate(deps);
  const say = async (): Promise<void> => {
    for (let i = 0; i < 15; i++) await gate.feed(loud());
    for (let i = 0; i < 60; i++) await gate.feed(quiet()); // ~1.9 s of silence
    await gate.close();
  };
  return { say, out, unaddressed, errors };
}

describe('AddressGate', () => {
  test('hands-free: an utterance not opening with the address word never reaches Gemini', async () => {
    const r = rig({ text: 'what time is it' });
    await r.say();
    expect(r.out).toEqual([]);
    expect(r.unaddressed).toEqual(['what time is it']);
  });

  test('hands-free: an utterance opening with the address word is released as one whole activity', async () => {
    const r = rig({ text: 'Patch, what time is it' });
    await r.say();
    expect(r.out[0]).toBe('start');
    expect(r.out.at(-1)).toBe('end');
    expect(r.out.filter((x) => x === 'start')).toHaveLength(1);
    expect(r.out.filter((x) => x === 'audio').length).toBeGreaterThan(10);
    expect(r.unaddressed).toEqual([]);
  });

  test('hands-free: inside the follow-up window the utterance streams live without being transcribed', async () => {
    const r = rig({ text: new Error('must not be asked'), msSinceSpoke: 5_000 });
    await r.say();
    expect(r.out[0]).toBe('start');
    expect(r.out.at(-1)).toBe('end');
    expect(r.errors).toEqual([]);
  });

  test('hands-free: outside the follow-up window the same utterance is dropped', async () => {
    const r = rig({ text: 'and another thing', msSinceSpoke: 31_000 });
    await r.say();
    expect(r.out).toEqual([]);
    expect(r.unaddressed).toEqual(['and another thing']);
  });

  test('call: every utterance streams, nothing is transcribed', async () => {
    const r = rig({ text: new Error('must not be asked'), requiresAddress: false });
    await r.say();
    expect(r.out[0]).toBe('start');
    expect(r.out.at(-1)).toBe('end');
    expect(r.errors).toEqual([]);
  });

  test('hands-free: a transcription failure is reported, not guessed', async () => {
    const r = rig({ text: new Error('stt down') });
    await r.say();
    expect(r.out).toEqual([]);
    expect(r.unaddressed).toEqual([]);
    expect(r.errors).toEqual(['stt down']);
  });

  test('hands-free: a one-character mishearing of the address word ("Hatch") is accepted', async () => {
    const r = rig({ text: 'Hatch, what time is it' });
    await r.say();
    expect(r.out[0]).toBe('start');
    expect(r.unaddressed).toEqual([]);
  });

  test('hands-free: the released audio is the whole utterance, including what came before the VAD fired', async () => {
    const sent: number[] = [];
    const gate = new AddressGate({
      vad: new MockVad(),
      transcriber: transcriber('Patch, hello'),
      addressWord: () => 'patch',
      requiresAddress: () => true,
      msSinceSpoke: () => undefined,
      endSilenceMs: 1000,
      activityStart: () => {},
      audio: (pcm) => sent.push(pcm.length),
      activityEnd: () => {},
      unaddressed: () => {},
      onError: () => {},
    });
    for (let i = 0; i < 5; i++) await gate.feed(quiet()); // pre-roll
    for (let i = 0; i < 15; i++) await gate.feed(loud());
    for (let i = 0; i < 60; i++) await gate.feed(quiet());
    await gate.close();
    // Pre-roll (up to 400 ms = ~13 frames; only 5 existed) plus the 15 loud frames, all intact.
    expect(sent.slice(0, 20).every((n) => n === FRAME)).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(20);
  });
});
