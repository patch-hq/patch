// Which engine the composer mic dictates with on the phone (spec/07 §
// Dictation engines), from the account's dictation setting.

import type { DictationConfig } from '@patch/wire/audio';
import type { DictationEngine } from './dictation';

export function dictationEngineFor(dictation: DictationConfig): {
  engine: DictationEngine;
  tidy: boolean;
} {
  switch (dictation.phone) {
    case 'device':
      return { engine: 'phone', tidy: dictation.tidy };
    case 'deepgram':
    case 'elevenlabs':
    case 'host':
      return { engine: 'stream', tidy: dictation.tidy };
    case 'whisper':
      return { engine: 'whisper', tidy: false };
  }
}
