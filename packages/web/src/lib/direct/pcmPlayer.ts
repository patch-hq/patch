// Plays a direct call's reply on this device: PCM16 pieces through Web Audio,
// one at a time, each stoppable for barge-in (spec/07 § Direct calls).

import type { PreparedSpeech } from '@patch/wire/direct-call-runtime';

export interface PcmPlayer {
  prepare(pcm: Int16Array, sampleRate: number): PreparedSpeech;
  close(): void;
}

export function createPcmPlayer(AudioCtx: typeof AudioContext = window.AudioContext): PcmPlayer {
  const ctx = new AudioCtx();
  return {
    prepare(pcm, sampleRate) {
      let node: AudioBufferSourceNode | null = null;
      let finish: (() => void) | null = null;
      let stopped = false;
      return {
        async play() {
          if (stopped) return;
          if (ctx.state === 'suspended') await ctx.resume();
          const buf = ctx.createBuffer(1, pcm.length, sampleRate);
          const ch = buf.getChannelData(0);
          for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 32768;
          await new Promise<void>((resolve) => {
            finish = resolve;
            node = ctx.createBufferSource();
            node.buffer = buf;
            node.connect(ctx.destination);
            node.onended = () => resolve();
            node.start();
          });
        },
        stop() {
          stopped = true;
          try {
            node?.stop();
          } catch {
            // already ended
          }
          finish?.();
        },
      };
    },
    close() {
      void ctx.close().catch(() => {});
    },
  };
}
