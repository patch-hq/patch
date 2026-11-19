// Which engine the composer mic dictates with on the phone (spec/07 §
// Dictation engines): this phone's own choice (`deviceDictation`), else the
// engine set for phones.

import {
  dictationEngineFor as wireEngineFor,
  type DictationConfig,
  type DictationEngine as SettingEngine,
} from '@patch/wire/audio';
import type { DictationEngine } from './dictation';

/** Throws, with the sentence to show, when this phone's choice cannot run on a phone. */
export function dictationEngineFor(
  dictation: DictationConfig,
  own?: {
    surfaceId?: string | undefined;
    deviceDictation?: Record<string, SettingEngine> | undefined;
  },
): {
  engine: DictationEngine;
  tidy: boolean;
} {
  const chosen = wireEngineFor(dictation, 'mobile', own);
  switch (chosen) {
    case 'device':
      return { engine: 'phone', tidy: dictation.tidy };
    case 'deepgram':
    case 'elevenlabs':
    case 'host':
      return { engine: 'stream', tidy: dictation.tidy };
    case 'whisper':
      return { engine: 'whisper', tidy: false };
    case 'local':
      // wireEngineFor already refuses `local` on a phone; unreachable.
      throw new Error(
        'Parakeet runs only in the desktop app. Pick another engine in Settings → Dictation.',
      );
  }
}
