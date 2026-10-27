// Which engine the composer mic dictates with on this phone (spec/07 §
// Dictation engines), from the account's dictation setting.

import type { DictationConfig } from '@patch/wire/audio';
import type { DictationEngine } from './dictation';

export function dictationEngineFor(
  dictation: DictationConfig,
  platform: string,
): { engine: DictationEngine; tidy: boolean } {
  if (dictation.phone && platform === 'android') return { engine: 'phone', tidy: dictation.tidy };
  if (dictation.backend === 'deepgram') return { engine: 'stream', tidy: dictation.tidy };
  return { engine: 'whisper', tidy: false };
}
