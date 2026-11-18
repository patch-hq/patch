// Short chime played once when a voice call goes live (first non-connecting
// state), so the user knows they can start speaking. A failure to play is
// surfaced, not swallowed.
import { Audio } from 'expo-av';
import { useUiStore } from '../stores/uiStore';

export async function playVoiceLiveCue(): Promise<void> {
  try {
    // Metro asset: static require is the only way to bundle it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const asset = require('../../assets/sounds/voice_live.wav');
    const { sound } = await Audio.Sound.createAsync(asset, { shouldPlay: true });
    sound.setOnPlaybackStatusUpdate((s) => {
      if (s.isLoaded && s.didJustFinish) void sound.unloadAsync();
    });
  } catch (e) {
    useUiStore.getState().pushError(`voice call: live cue failed: ${(e as Error).message}`);
  }
}
