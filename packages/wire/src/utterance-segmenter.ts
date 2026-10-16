// Splits a continuous 16 kHz PCM16 mic stream into utterances, for the
// composer's dictation mode (spec/07 § Dictation mode): the mic stays open, and
// each time the speaker goes quiet for `silenceMs` the speech so far is handed
// back as one utterance.
//
// Time is counted in SAMPLES, never wall-clock, so the same stream always
// segments the same way regardless of how the platform batches its frames.

export interface UtteranceSegmenterOptions {
  sampleRate?: number;
  /** Quiet this long after speech ends the utterance. */
  silenceMs?: number;
  /** Frame RMS (0..1) above which a frame counts as speech. */
  speechRms?: number;
  /** Speech shorter than this is a cough or a click, not an utterance. */
  minSpeechMs?: number;
  /** Audio kept from before the first loud frame so a soft start is not clipped. */
  preRollMs?: number;
  /** An utterance still running at this length is flushed anyway. */
  maxUtteranceMs?: number;
}

export const DEFAULT_SILENCE_MS = 3000;

export interface UtteranceSegmenter {
  /** Feed one frame; returns the finished utterance's PCM when this frame completed one. */
  push(pcm: Int16Array): Int16Array | null;
  /** True between the first loud frame and the end of the utterance. */
  readonly speaking: boolean;
}

export function frameRms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s = (pcm[i] ?? 0) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / pcm.length);
}

function concat(chunks: Int16Array[]): Int16Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Int16Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function createUtteranceSegmenter(opts: UtteranceSegmenterOptions = {}): UtteranceSegmenter {
  const rate = opts.sampleRate ?? 16000;
  const perMs = rate / 1000;
  const silenceSamples = (opts.silenceMs ?? DEFAULT_SILENCE_MS) * perMs;
  const speechRms = opts.speechRms ?? 0.015;
  const minSpeechSamples = (opts.minSpeechMs ?? 300) * perMs;
  const preRollSamples = (opts.preRollMs ?? 300) * perMs;
  const maxSamples = (opts.maxUtteranceMs ?? 120_000) * perMs;

  let preRoll: Int16Array[] = [];
  let preRollLen = 0;
  let chunks: Int16Array[] = [];
  let total = 0;
  let loud = 0; // samples of loud frames in this utterance
  let quiet = 0; // trailing quiet samples
  let speaking = false;

  function finish(): Int16Array | null {
    const out = loud >= minSpeechSamples ? concat(chunks) : null;
    chunks = [];
    total = 0;
    loud = 0;
    quiet = 0;
    speaking = false;
    return out;
  }

  return {
    get speaking(): boolean {
      return speaking;
    },
    push(pcm: Int16Array): Int16Array | null {
      const isLoud = frameRms(pcm) >= speechRms;
      if (!speaking) {
        if (!isLoud) {
          preRoll.push(pcm);
          preRollLen += pcm.length;
          while (preRoll.length > 1 && preRollLen - (preRoll[0]?.length ?? 0) >= preRollSamples) {
            preRollLen -= preRoll.shift()?.length ?? 0;
          }
          return null;
        }
        speaking = true;
        chunks = preRoll;
        total = preRollLen;
        preRoll = [];
        preRollLen = 0;
      }
      chunks.push(pcm);
      total += pcm.length;
      if (isLoud) {
        loud += pcm.length;
        quiet = 0;
      } else {
        quiet += pcm.length;
      }
      if (quiet >= silenceSamples || total >= maxSamples) return finish();
      return null;
    },
  };
}
