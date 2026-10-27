// JS bridge to the PatchSpeech native module: the phone's own speech
// recogniser, fed the frames Patch's mic tap is already capturing (spec/07 §
// Dictation engines; plugins/native/PatchSpeechModule.kt).
//
// NO FALLBACK: a missing module on Android throws, and every recogniser
// failure reaches `onError`.

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

interface PatchSpeechModule {
  start: (language: string) => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
  addListener: (event: string) => void;
  removeListeners: (count: number) => void;
}

export interface PhoneSpeechEvent {
  type: 'partial' | 'segment' | 'end' | 'error';
  text?: string;
  message?: string;
}

const EVENT = 'PatchSpeechEvent';

function getModule(): PatchSpeechModule {
  if (Platform.OS !== 'android') {
    throw new Error("the phone's own recogniser is only on Android");
  }
  const mod = (NativeModules as Record<string, unknown>)['PatchSpeech'];
  if (!mod) {
    throw new Error(
      'PatchSpeech native module missing — this app build predates the phone recogniser; install the latest APK',
    );
  }
  return mod as PatchSpeechModule;
}

export interface PhoneSpeechSession {
  /** Close the audio feed; `end` follows once the last words are in. */
  stop(): Promise<void>;
  /** Drop the session and its results. */
  cancel(): Promise<void>;
}

/** Start recognising. Resolves once the recogniser is listening to the tap. */
export async function startPhoneSpeech(
  onEvent: (ev: PhoneSpeechEvent) => void,
  language = 'en-GB',
): Promise<PhoneSpeechSession> {
  const mod = getModule();
  const emitter = new NativeEventEmitter(mod as never);
  const sub = emitter.addListener(EVENT, (ev: PhoneSpeechEvent) => {
    onEvent(ev);
    if (ev.type === 'end' || ev.type === 'error') sub.remove();
  });
  try {
    await mod.start(language);
  } catch (e) {
    sub.remove();
    throw e;
  }
  return {
    stop: () => mod.stop(),
    async cancel(): Promise<void> {
      sub.remove();
      await mod.cancel();
    },
  };
}
