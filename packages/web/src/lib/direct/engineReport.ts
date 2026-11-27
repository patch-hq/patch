// Reports this surface's speech engines to the server (spec/05 § Speech
// engines): on every connect, and whenever they change — a host gains or loses
// a key, or a model is downloaded on this computer.

import type { WireEvent } from '@patch/wire';
import type { SpeechEngineReport } from '@patch/wire/direct-call';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { currentSpeechEngines } from './engines.js';

type Send = (e: Extract<WireEvent, { type: 'surface.speech_engines' }>) => void;

export interface SpeechEngineReporter {
  /** Send the report now, changed or not (a fresh connection). */
  report(): void;
  stop(): void;
}

export function startSpeechEngineReports(
  send: Send,
  read: () => Promise<SpeechEngineReport> = currentSpeechEngines,
): SpeechEngineReporter {
  let last: string | null = null;
  let stopped = false;
  const run = (force: boolean): void => {
    read().then(
      (r) => {
        const key = JSON.stringify(r);
        if (stopped || (!force && key === last)) return;
        last = key;
        send({ type: 'surface.speech_engines', stt: r.stt, tts: r.tts });
      },
      (err: unknown) => console.error('[patch] could not read this device’s speech engines', err),
    );
  };
  const unsub = usePresenceStore.subscribe((s, prev) => {
    if (s.hosts !== prev.hosts) run(false);
  });
  refreshers.add(() => run(false));
  return {
    report: () => run(true),
    stop: () => {
      stopped = true;
      unsub();
    },
  };
}

const refreshers = new Set<() => void>();

/** Report again after something on this device changed (a model downloaded). */
export function refreshSpeechEngines(): void {
  for (const r of refreshers) r();
}
