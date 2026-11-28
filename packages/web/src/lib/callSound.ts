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
/** The app-start render, while it runs: a press in that moment plays as soon as it lands. */
let warming: Promise<void> | null = null;

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
export function warmCallSounds(): Promise<void> {
  warming = (async () => {
    const c = audio('warm');
    await Promise.all(
      CALL_SOUND_NAMES.map(async (name) => {
        buffers.set(name, await renderCallSound(name, c.sampleRate));
      }),
    );
  })();
  return warming;
}

/**
 * Start `name` now, in this task, and return its source. A press that lands
 * while the app-start render is still running gets `null`: the caller starts it
 * the moment the render lands. Throws if the sounds were never warmed at all.
 */
function play(name: CallSoundName): AudioBufferSourceNode | null {
  const c = audio(name);
  const buffer = buffers.get(name);
  if (buffer === undefined) {
    if (warming === null) throw new Error(`call sound (${name}) was not warmed at app start`);
    return null;
  }
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
  if (play(cue) === null) void warming!.then(() => play(cue));
}

const loops = new Map<LoopingSound, AudioBufferSourceNode>();
/** Loops asked for while the app-start render was still running. */
const pendingLoops = new Set<LoopingSound>();

/** Start a looping sound; starting one already playing does nothing. */
export function startCallSoundLoop(name: LoopingSound): void {
  if (loops.has(name) || pendingLoops.has(name)) return;
  const source = play(name);
  if (source !== null) {
    loops.set(name, source);
    return;
  }
  pendingLoops.add(name);
  void warming!.then(() => {
    if (!pendingLoops.delete(name)) return;
    const late = play(name);
    if (late !== null) loops.set(name, late);
  });
}

export function stopCallSoundLoop(name: LoopingSound): void {
  pendingLoops.delete(name);
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
  return [...loops.keys(), ...pendingLoops];
}

export function __resetCallSoundForTests(): void {
  for (const name of [...loops.keys()]) stopCallSoundLoop(name);
  buffers.clear();
  pendingLoops.clear();
  warming = null;
  ctx = null;
}
