// JS bridge to the Android VoiceAudioService foreground service.
//
// The service's notification is the control surface for a phone the user is not
// looking at (spec/15 § Voice tab), so this bridge is two-way: JS pushes the
// session's mode and mute state into the notification, and the notification's
// own buttons come back as `PatchVoiceAudioAction` events.
//
// NO FALLBACK: if the native module is missing on Android we throw —
// that means the prebuild didn't include PatchVoiceAudioServicePackage
// and a release build would silently lose the foreground notification.
// On non-Android (test, dev web) we no-op.

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { AudioSessionMode } from '@patch/wire/audio';

/**
 * What the notification's buttons ask JS to do, and the headphones coming and
 * going (spec/07 § Pause), which JS turns into a pause or a resume.
 */
export type VoiceServiceAction =
  | 'mute'
  | 'mode'
  | 'stop'
  | 'resume'
  | 'headset_removed'
  | 'headset_added';

const ACTIONS: ReadonlySet<string> = new Set<VoiceServiceAction>([
  'mute',
  'mode',
  'stop',
  'resume',
  'headset_removed',
  'headset_added',
]);

interface PatchVoiceAudioServiceModule {
  start: (
    chatName: string | null,
    mode: string,
    muted: boolean,
    transientFocus: boolean,
  ) => Promise<void>;
  update: (
    chatName: string | null,
    mode: string,
    muted: boolean,
    paused: boolean,
    transientFocus: boolean,
  ) => Promise<void>;
  stop: () => Promise<void>;
}

/** How the session holds audio, as the service is told on every start and update. */
export interface VoiceServiceState {
  mode: AudioSessionMode;
  muted: boolean;
  /** Paused (spec/07 § Pause): audio focus and the headset route are released. */
  paused: boolean;
  /**
   * AUDIOFOCUS_GAIN_TRANSIENT rather than GAIN: a call answered on its own for
   * an agent, so other playback pauses and resumes when it ends.
   */
  transientFocus: boolean;
}

function getModule(): PatchVoiceAudioServiceModule | null {
  if (Platform.OS !== 'android') return null;
  const mod = (NativeModules as Record<string, unknown>)['PatchVoiceAudioService'];
  if (!mod) {
    throw new Error(
      'PatchVoiceAudioService native module missing — is the package registered in MainApplication.kt?',
    );
  }
  return mod as PatchVoiceAudioServiceModule;
}

export async function startVoiceAudioService(
  chatName: string | null,
  state: Omit<VoiceServiceState, 'paused'>,
): Promise<void> {
  const m = getModule();
  if (!m) return;
  await m.start(chatName, state.mode, state.muted, state.transientFocus);
}

/** Re-render the notification (and pause or retake the audio) for a running service. */
export async function updateVoiceAudioService(
  chatName: string | null,
  state: VoiceServiceState,
): Promise<void> {
  const m = getModule();
  if (!m) return;
  await m.update(chatName, state.mode, state.muted, state.paused, state.transientFocus);
}

export async function stopVoiceAudioService(): Promise<void> {
  const m = getModule();
  if (!m) return;
  await m.stop();
}

/**
 * Subscribe to the notification's own button presses. Returns an unsubscribe.
 * A no-op off Android, where there is no notification to press.
 */
export function onVoiceServiceAction(handler: (action: VoiceServiceAction) => void): () => void {
  if (Platform.OS !== 'android') return () => {};
  const mod = (NativeModules as Record<string, unknown>)['PatchVoiceAudioService'];
  if (!mod) return () => {};
  const emitter = new NativeEventEmitter(mod as never);
  const sub = emitter.addListener('PatchVoiceAudioAction', (action: string) => {
    if (ACTIONS.has(action)) handler(action as VoiceServiceAction);
  });
  return () => sub.remove();
}
