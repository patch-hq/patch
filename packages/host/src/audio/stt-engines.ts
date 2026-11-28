// The account's speech-to-text choice (spec/07 § Speech to text), built on this
// host. A turn-based call reads speech with the engine the account picked, not
// whatever WHISPER_BACKEND the host started with. Whether this host CAN run the
// engine is the readiness model's question (wire `voiceReadiness`), asked before
// this is called; an engine that is not ready here throws, loudly.

import type { SpeechToTextEngine } from '@patch/wire/audio';
import type { WhisperBackend } from './whisper.js';

export interface SpeechToTextDeps {
  /** The engine's backend. Throws when this host cannot run it. */
  build: (engine: SpeechToTextEngine) => WhisperBackend;
}

/** Asks the host each call, so a key or model added later applies to the next session. */
export function createSpeechToTextResolver(
  deps: SpeechToTextDeps,
): (engine: SpeechToTextEngine) => WhisperBackend {
  return (engine) => deps.build(engine);
}
