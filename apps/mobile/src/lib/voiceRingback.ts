// Ringback tone looped while a call is connecting, so the user hears that
// the call is being placed. Stopped the moment the call leaves `connecting`,
// fails or ends. A failure to play is surfaced, not swallowed.
import { Audio } from 'expo-av';
import { useUiStore } from '../stores/uiStore';
import { ringbackAsset } from './voiceRingbackAsset';

let _sound: Audio.Sound | null = null;
let _want = false;

export async function startRingback(): Promise<void> {
  if (_want) return;
  _want = true;
  try {
    const { sound } = await Audio.Sound.createAsync(ringbackAsset, {
      shouldPlay: true,
      isLooping: true,
    });
    if (!_want) {
      await sound.unloadAsync();
      return;
    }
    _sound = sound;
  } catch (e) {
    _want = false;
    useUiStore.getState().pushError(`voice call: ringing tone failed: ${(e as Error).message}`);
  }
}

export async function stopRingback(): Promise<void> {
  _want = false;
  const s = _sound;
  _sound = null;
  if (s === null) return;
  try {
    await s.stopAsync();
    await s.unloadAsync();
  } catch (e) {
    useUiStore
      .getState()
      .pushError(`voice call: stopping ringing tone failed: ${(e as Error).message}`);
  }
}
