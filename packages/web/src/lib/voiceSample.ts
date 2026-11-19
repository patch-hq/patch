// Record a voice sample for a voice profile (spec/16 § Who is speaking): a few
// seconds from the microphone as 16 kHz PCM16, base64, the form the host turns
// into a voiceprint.

import { createPcm16Downsampler } from './pcmDownsample.js';

/** Long enough for a steady voiceprint; short enough to read one sentence twice. */
export const VOICE_SAMPLE_SECONDS = 8;

export interface VoiceSampleRecording {
  /** Resolves with the sample once `seconds` have passed or `stop()` is called. */
  done: Promise<string>;
  stop: () => void;
}

/** Start recording. Rejects (through `done`) when the microphone cannot be opened. */
export function recordVoiceSample(
  seconds = VOICE_SAMPLE_SECONDS,
  onProgress?: (elapsed: number) => void,
): VoiceSampleRecording {
  let stop: () => void = () => {};
  const done = (async (): Promise<string> => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but universal, and this is a few seconds.
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const down = createPcm16Downsampler(ctx.sampleRate);
    const chunks: Int16Array[] = [];
    let samples = 0;
    return new Promise<string>((resolve) => {
      const finish = (): void => {
        node.disconnect();
        source.disconnect();
        for (const t of stream.getTracks()) t.stop();
        void ctx.close();
        const pcm = new Int16Array(samples);
        let at = 0;
        for (const c of chunks) {
          pcm.set(c, at);
          at += c.length;
        }
        resolve(pcm16ToBase64(pcm));
      };
      stop = finish;
      node.onaudioprocess = (e) => {
        const out = down(e.inputBuffer.getChannelData(0));
        chunks.push(out);
        samples += out.length;
        onProgress?.(samples / 16000);
        if (samples >= seconds * 16000) finish();
      };
      source.connect(node);
      node.connect(ctx.destination);
    });
  })();
  return { done, stop: () => stop() };
}

export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
