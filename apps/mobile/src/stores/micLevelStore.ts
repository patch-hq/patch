// Live microphone level (0..1) for the dictation level bar. Fed from every
// native mic frame (lib/voiceMic.ts), so the bar follows the voice whichever
// dictation engine is running. The level rises quickly and falls slowly (a
// peak-meter envelope) so the bar reads as live without flickering.

import { create } from 'zustand';

const ATTACK = 0.6;
const RELEASE = 0.15;
// Speech RMS sits well under full scale; this makes normal speech fill most of the bar.
const GAIN = 4;

/** RMS of one PCM16 frame as 0..1. */
export function pcmLevel(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]! / 32768;
    sumSq += v * v;
  }
  return Math.min(1, Math.sqrt(sumSq / pcm.length) * GAIN);
}

interface MicLevelState {
  level: number;
  push(pcm: Int16Array): void;
  reset(): void;
}

export const useMicLevelStore = create<MicLevelState>((set, get) => ({
  level: 0,
  push(pcm) {
    const prev = get().level;
    const next = pcmLevel(pcm);
    set({ level: prev + (next - prev) * (next > prev ? ATTACK : RELEASE) });
  },
  reset() {
    set({ level: 0 });
  },
}));
