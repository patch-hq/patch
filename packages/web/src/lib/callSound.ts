// Plays the sounds of a call (spec/07 § Call sounds) in the page, on the same
// output the call's audio uses, so they are heard where the call is heard and
// cost nothing. The sounds are defined once, in callSoundSynth.ts; the phone
// plays the same definitions rendered to files.
//
// Every sound is rendered once at app start (warmCallSounds) and played from it. A looping one
// (connecting, reconnecting, agent calling, agent working) is looped by the
// audio clock until it is stopped, which keeps time in a background tab where
// page timers are throttled.

import {
  CALL_SOUNDS,
  CALL_SOUND_NAMES,
  renderCallSound,
  type CallSoundName,
} from './callSoundSynth.js';

export type LoopingSound = 'connecting' | 'reconnecting' | 'agent-calling' | 'agent-working';
/** A one-off sound: any call sound that does not loop. */
export type CallCue = Exclude<CallSoundName, LoopingSound>;

let ctx: AudioContext | null = null;
const buffers = new Map<CallSoundName, AudioBuffer>();

function audio(what: string): AudioContext {
  if (ctx === null) {
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx === undefined)
      throw new Error(`call sound (${what}): this browser has no AudioContext`);
    ctx = new Ctx();
  }
  return ctx;
}

/**
 * Render every call sound once, at app start, so a press never waits for one:
 * playing is then a synchronous start in the press's own task. The context is
 * created here too; the browser keeps it suspended until the first press, which
 * resumes it (play).
 */
export async function warmCallSounds(): Promise<void> {
  const c = audio('warm');
  await Promise.all(
    CALL_SOUND_NAMES.map(async (name) => {
      buffers.set(name, await renderCallSound(name, c.sampleRate));
    }),
  );
}

/** Start `name` now, in this task. Returns its source; throws if it was not warmed. */
function play(name: CallSoundName): AudioBufferSourceNode {
  const c = audio(name);
  const buffer = buffers.get(name);
  if (buffer === undefined) throw new Error(`call sound (${name}) was not warmed at app start`);
  if (c.state === 'suspended') {
    c.resume().catch((e: unknown) => console.error(`call sound (${name}): ${String(e)}`));
  }
  const source = c.createBufferSource();
  source.buffer = buffer;
  source.loop = CALL_SOUNDS[name].loop;
  source.connect(c.destination);
  source.start();
  return source;
}

export function playCallSound(cue: CallCue): void {
  play(cue);
}

const loops = new Map<LoopingSound, AudioBufferSourceNode>();

/** Start a looping sound; starting one already playing does nothing. */
export function startCallSoundLoop(name: LoopingSound): void {
  if (loops.has(name)) return;
  loops.set(name, play(name));
}

export function stopCallSoundLoop(name: LoopingSound): void {
  loops.get(name)?.stop();
  loops.delete(name);
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
