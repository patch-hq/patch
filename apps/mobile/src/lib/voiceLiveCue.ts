// Short chime played once when a voice call goes live (first non-connecting
// state), so the user knows they can start speaking. A failure to play is
// surfaced, not swallowed.
import { Audio } from 'expo-av';
import { useUiStore } from '../stores/uiStore';

export async function playVoiceLiveCue(): Promise<void> {
  try {
    const { sound } = await Audio.Sound.createAsync(require('../../assets/sounds/voice_live.wav'), {
      shouldPlay: true,
    });
    sound.setOnPlaybackStatusUpdate((s) => {
      if (s.isLoaded && s.didJustFinish) void sound.unloadAsync();
    });
  } catch (e) {
    useUiStore.getState().pushError(`voice call: live cue failed: ${(e as Error).message}`);
  }
}
