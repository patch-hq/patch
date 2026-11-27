// Reports this surface's speech engines to the server (spec/05 § Speech
// engines), with the reporter every surface shares.

import type { WireEvent } from '@patch/wire';
import {
  createSpeechEngineReporter,
  type SpeechEngineReport,
  type SpeechEngineReporter,
} from '@patch/wire/direct-call';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { currentSpeechEngines } from './engines.js';

export type { SpeechEngineReporter };

export function startSpeechEngineReports(
  send: (e: Extract<WireEvent, { type: 'surface.speech_engines' }>) => void,
  read: () => Promise<SpeechEngineReport> = currentSpeechEngines,
): SpeechEngineReporter {
  return createSpeechEngineReporter({
    read,
    send,
    onHostsChange: (cb) =>
      usePresenceStore.subscribe((s, prev) => {
        if (s.hosts !== prev.hosts) cb();
      }),
    onError: (err) => console.error('[patch] could not read this device’s speech engines', err),
  });
}
