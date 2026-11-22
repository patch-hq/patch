// Short sounds for a voice call's lifecycle: a chime when it goes live (so the
// user knows they can speak), a falling pair when it ends, and a low double
// beep when it fails. Ringing while connecting or redialling is voiceRingback.
// A failure to play is surfaced, not swallowed.
import { Audio } from 'expo-av';
import { useUiStore } from '../stores/uiStore';

export type VoiceCue = 'live' | 'ended' | 'error';

function assetFor(cue: VoiceCue): number {
  // Metro assets: static requires are the only way to bundle them.
  /* eslint-disable @typescript-eslint/no-require-imports */
  switch (cue) {
    case 'live':
      return require('../../assets/sounds/voice_live.wav');
    case 'ended':
      return require('../../assets/sounds/voice_ended.wav');
    case 'error':
      return require('../../assets/sounds/voice_error.wav');
  }
  /* eslint-enable @typescript-eslint/no-require-imports */
}

export async function playVoiceCue(cue: VoiceCue): Promise<void> {
  try {
    const { sound } = await Audio.Sound.createAsync(assetFor(cue), { shouldPlay: true });
    sound.setOnPlaybackStatusUpdate((s) => {
      if (s.isLoaded && s.didJustFinish) void sound.unloadAsync();
    });
  } catch (e) {
    useUiStore.getState().pushError(`voice call: ${cue} cue failed: ${(e as Error).message}`);
  }
}

export const playVoiceLiveCue = (): Promise<void> => playVoiceCue('live');
