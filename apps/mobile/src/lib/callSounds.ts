// The sounds a call makes (spec/07 § Call sounds), played by the phone itself
// from bundled files: nothing comes from the provider, nothing needs the
// network, so the reconnecting sound plays with no signal at all.
//
// A one-off sound plays once and unloads. A looping one (connecting,
// reconnecting, agent calling, agent working) repeats until it is stopped. A
// failure to play is surfaced, not swallowed.
import { Audio } from 'expo-av';
import { useUiStore } from '../stores/uiStore';
import { CALL_SOUND_ASSETS } from './callSoundAssets';

export type CallSoundName =
  | 'connecting'
  | 'connected'
  | 'passed-to-agent'
  | 'reconnecting'
  | 'reconnected'
  | 'paused'
  | 'ended'
  | 'agent-calling'
  | 'agent-working'
  | 'failed';

export type LoopingSound = 'connecting' | 'reconnecting' | 'agent-calling' | 'agent-working';
/** A one-off sound: any call sound that does not loop. */
export type CallCue = Exclude<CallSoundName, LoopingSound>;

export async function playCallSound(cue: CallCue): Promise<void> {
  try {
    const { sound } = await Audio.Sound.createAsync(CALL_SOUND_ASSETS[cue], { shouldPlay: true });
    sound.setOnPlaybackStatusUpdate((s) => {
      if (s.isLoaded && s.didJustFinish) void sound.unloadAsync();
    });
  } catch (e) {
    useUiStore.getState().pushError(`voice call: ${cue} sound failed: ${(e as Error).message}`);
  }
}

interface Loop {
  sound: Audio.Sound | null;
  stopped: boolean;
}
const loops = new Map<LoopingSound, Loop>();

/** Start a looping sound; starting one already playing does nothing. */
export async function startCallSoundLoop(name: LoopingSound): Promise<void> {
  if (loops.has(name)) return;
  const loop: Loop = { sound: null, stopped: false };
  loops.set(name, loop);
  try {
    const { sound } = await Audio.Sound.createAsync(CALL_SOUND_ASSETS[name], {
      shouldPlay: true,
      isLooping: true,
    });
    if (loop.stopped) {
      await sound.unloadAsync();
      return;
    }
    loop.sound = sound;
  } catch (e) {
    if (loops.get(name) === loop) loops.delete(name);
    useUiStore.getState().pushError(`voice call: ${name} sound failed: ${(e as Error).message}`);
  }
}

export async function stopCallSoundLoop(name: LoopingSound): Promise<void> {
  const loop = loops.get(name);
  if (loop === undefined) return;
  loops.delete(name);
  loop.stopped = true;
  const s = loop.sound;
  if (s === null) return;
  try {
    await s.stopAsync();
    await s.unloadAsync();
  } catch (e) {
    useUiStore
      .getState()
      .pushError(`voice call: stopping the ${name} sound failed: ${(e as Error).message}`);
  }
}

/** Start or stop a looping sound to match whether its state holds. */
export function syncCallSoundLoop(name: LoopingSound, on: boolean): void {
  void (on ? startCallSoundLoop(name) : stopCallSoundLoop(name));
}

/** Every looping sound playing now. */
export function playingCallSoundLoops(): LoopingSound[] {
  return [...loops.keys()];
}
