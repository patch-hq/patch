// The account's speech-to-text choice (spec/07 § Speech to text), resolved on
// this host. A turn-based call reads speech with the engine the account picked,
// not whatever WHISPER_BACKEND the host started with. An engine this host cannot
// run (key missing, model not installed) is reported by name so the session is
// refused — NO FALLBACK to another engine.

import { SPEECH_TO_TEXT_LABEL, type SpeechToTextEngine } from '@patch/wire/audio';
import type { WhisperBackend } from './whisper.js';

export type SpeechToTextResolution =
  | { ok: true; whisper: WhisperBackend }
  | { ok: false; engine: SpeechToTextEngine; message: string };

export interface SpeechToTextDeps {
  /** The engine's backend when this host can run it right now, else the reason it can't. */
  build: (engine: SpeechToTextEngine) => { whisper: WhisperBackend } | { unavailable: string };
}

/** Asks the host each call, so a key or model added later applies to the next session. */
export function createSpeechToTextResolver(
  deps: SpeechToTextDeps,
): (engine: SpeechToTextEngine) => SpeechToTextResolution {
  return (engine) => {
    const r = deps.build(engine);
    if ('unavailable' in r) {
      return {
        ok: false,
        engine,
        message: `Speech to text is set to ${SPEECH_TO_TEXT_LABEL[engine]}, but ${r.unavailable}. Switch Speech to text to another engine in Settings → Voice.`,
      };
    }
    return { ok: true, whisper: r.whisper };
  };
}
