// The sounds a call makes (spec/07 § Call sounds), played by the phone itself
// from bundled files: nothing comes from the provider, nothing needs the
// network, so the reconnecting sound plays with no signal at all.
//
// They play natively (PatchCallSoundsModule) as call signalling that holds no
// audio focus of its own: a player that asked for focus — as expo-av does —
// loses it to the call the instant the call takes its own, and stops, which is
// what silenced the connecting sound a few milliseconds after the tap.
//
// Every sound is preloaded at app start (preloadCallSounds), so starting one is
// immediate. A one-off sound plays once. A looping one (connecting, reconnecting, agent
// calling, agent working) repeats until it is stopped. A failure to play is
// surfaced, not swallowed.
import { Image, NativeModules, Platform } from 'react-native';
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

interface PatchCallSoundsNative {
  preload(name: string, uri: string, loop: boolean): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
}

function native(): PatchCallSoundsNative {
  if (Platform.OS !== 'android') {
    throw new Error(`call sounds play through the Android voice service; ${Platform.OS} has none`);
  }
  const mod = (NativeModules as Record<string, unknown>)['PatchCallSounds'];
  if (!mod) {
    throw new Error(
      'PatchCallSounds native module missing — is PatchVoiceAudioServicePackage registered?',
    );
  }
  return mod as PatchCallSoundsNative;
}

/** The bundled file behind a sound: a resource name when embedded, a file URI from an update. */
function uriOf(name: CallSoundName): string {
  return Image.resolveAssetSource(CALL_SOUND_ASSETS[name]).uri;
}

const LOOPING: ReadonlySet<CallSoundName> = new Set([
  'connecting',
  'reconnecting',
  'agent-calling',
  'agent-working',
]);

/**
 * Prepare every sound in the native player, once, at app start: a press then
 * starts the connecting sound with nothing to open or decode first. Anything
 * that fails to load is surfaced here, not at the first call.
 */
export async function preloadCallSounds(): Promise<void> {
  const mod = native();
  await Promise.all(
    (Object.keys(CALL_SOUND_ASSETS) as CallSoundName[]).map((name) =>
      mod.preload(name, uriOf(name), LOOPING.has(name)),
    ),
  );
}

export async function playCallSound(cue: CallCue): Promise<void> {
  try {
    await native().start(cue);
  } catch (e) {
    useUiStore.getState().pushError(`voice call: ${cue} sound failed: ${(e as Error).message}`);
  }
}

/** Each playing loop, by the start that owns it. */
const loops = new Map<LoopingSound, symbol>();

/** Start a looping sound; starting one already playing does nothing. */
export async function startCallSoundLoop(name: LoopingSound): Promise<void> {
  if (loops.has(name)) return;
  const mine = Symbol(name);
  loops.set(name, mine);
  try {
    await native().start(name);
  } catch (e) {
    if (loops.get(name) === mine) loops.delete(name);
    useUiStore.getState().pushError(`voice call: ${name} sound failed: ${(e as Error).message}`);
  }
}

export async function stopCallSoundLoop(name: LoopingSound): Promise<void> {
  if (!loops.delete(name)) return;
  try {
    await native().stop(name);
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
