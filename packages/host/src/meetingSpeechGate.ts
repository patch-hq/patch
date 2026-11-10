// A call clip with no speech in it must not reach the speech-to-text engine: fed
// silence or room noise, Parakeet/Whisper invent fluent text ("Thank you for
// watching!") that then lands in the notes. The gate runs the host's VAD over the
// clip and keeps it only if enough of it is speech.
import type { Vad } from './audio/vad.js';

const FRAME_SAMPLES = 480; // 30 ms
const FRAME_MS = 30;
const WAV_HEADER_BYTES = 44;
/** Speech below this much in total is a cough or a click, not words. */
export const MIN_SPEECH_MS = 240;

/** True when the 16 kHz mono WAV holds at least MIN_SPEECH_MS of speech. */
export async function clipHasSpeech(wav: Buffer, vad: Vad, startTh: number): Promise<boolean> {
  const bytes = wav.subarray(WAV_HEADER_BYTES);
  const pcm = new Int16Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length - (bytes.length % 2)),
  );
  let speechMs = 0;
  try {
    for (let i = 0; i + FRAME_SAMPLES <= pcm.length; i += FRAME_SAMPLES) {
      const r = await vad.feed(pcm.subarray(i, i + FRAME_SAMPLES), FRAME_MS);
      if (r.prob > startTh) speechMs += FRAME_MS;
      if (speechMs >= MIN_SPEECH_MS) return true;
    }
    return false;
  } finally {
    vad.reset();
  }
}
