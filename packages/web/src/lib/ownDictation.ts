// The dictation engine this device runs on (spec/07 § Dictation engines): its
// own choice in `deviceDictation`, else the engine set for its kind.

import type { DictationEngine } from '@patch/wire/audio';
import type { SharedSettings } from '@patch/wire';
import { decodeSurfaceClaims } from './credential.js';

export function ownDictationEngine(
  prefs: Pick<SharedSettings, 'voiceConfig' | 'deviceDictation'>,
): DictationEngine {
  const own = decodeSurfaceClaims()?.surfaceId;
  return (
    (own !== undefined ? prefs.deviceDictation?.[own] : undefined) ??
    prefs.voiceConfig.dictation.computer
  );
}
