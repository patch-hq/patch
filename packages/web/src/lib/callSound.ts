// Plays the sounds of a call (spec/07 § Call sounds) in the page, on the same
// output the call's audio uses, so they are heard where the call is heard and
// cost nothing. The sounds are defined once, in callSoundSynth.ts; the phone
// plays the same definitions rendered to files.
//
// Every sound is rendered once into a buffer and played from it. A looping one
// (connecting, reconnecting, agent calling, agent working) is looped by the
// audio clock until it is stopped, which keeps time in a background tab where
// page timers are throttled.

import { CALL_SOUNDS, renderCallSound, type CallSoundName } from './callSoundSynth.js';

export type LoopingSound = 'connecting' | 'reconnecting' | 'agent-calling' | 'agent-working';
/** A one-off sound: any call sound that does not loop. */
export type CallCue = Exclude<CallSoundName, LoopingSound>;

let ctx: AudioContext | null = null;
const buffers = new Map<CallSoundName, Promise<AudioBuffer>>();

function audio(what: string): AudioContext | null {
  if (ctx === null) {
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx === undefined) {
      console.error(`call sound (${what}): this browser has no AudioContext`);
      return null;
    }
    ctx = new Ctx();
  }
  if (ctx.state === 'suspended') {
    ctx.resume().catch((e: unknown) => console.error(`call sound (${what}): ${String(e)}`));
  }
  return ctx;
}

/**
 * Start `name` playing; resolves to its source, or null when it did not play.
 * `wanted` is asked again once the buffer is ready, so a sound stopped while it
 * rendered never starts.
 */
async function play(
  name: CallSoundName,
  wanted: () => boolean = () => true,
): Promise<AudioBufferSourceNode | null> {
  const c = audio(name);
  if (c === null) return null;
  let buffer = buffers.get(name);
  if (buffer === undefined) {
    buffer = renderCallSound(name, c.sampleRate);
    buffers.set(name, buffer);
  }
  try {
    const rendered = await buffer;
    if (!wanted()) return null;
    const source = c.createBufferSource();
    source.buffer = rendered;
    source.loop = CALL_SOUNDS[name].loop;
    source.connect(c.destination);
    source.start(c.currentTime + 0.03);
    return source;
  } catch (e) {
    buffers.delete(name);
    console.error(`call sound (${name}): could not play: ${String(e)}`);
    return null;
  }
}

export function playCallSound(cue: CallCue): void {
  void play(cue);
}

interface Loop {
  source: AudioBufferSourceNode | null;
  stopped: boolean;
}
const loops = new Map<LoopingSound, Loop>();

/** Start a looping sound; starting one already playing does nothing. */
export function startCallSoundLoop(name: LoopingSound): void {
  if (loops.has(name)) return;
  const loop: Loop = { source: null, stopped: false };
  loops.set(name, loop);
  void play(name, () => !loop.stopped).then((source) => {
    if (source !== null) loop.source = source;
    else if (loops.get(name) === loop) loops.delete(name);
  });
}

export function stopCallSoundLoop(name: LoopingSound): void {
  const loop = loops.get(name);
  if (loop === undefined) return;
  loops.delete(name);
  loop.stopped = true;
  loop.source?.stop();
}

/** Start or stop a looping sound to match whether its state holds. */
export function syncCallSoundLoop(name: LoopingSound, on: boolean): void {
  if (on) startCallSoundLoop(name);
  else stopCallSoundLoop(name);
}

/** Every looping sound playing now. */
export function playingCallSoundLoops(): LoopingSound[] {
  return [...loops.keys()];
}

export function __resetCallSoundForTests(): void {
  for (const name of [...loops.keys()]) stopCallSoundLoop(name);
  buffers.clear();
  ctx = null;
}
