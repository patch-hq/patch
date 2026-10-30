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
  /**
   * A shorter quiet after speech at which to ask whether the speaker has
   * finished (dictation mode's end-of-turn check). Fires `onPause` once per
   * quiet stretch with the utterance so far; the utterance carries on until
   * `cut` ends it or `silenceMs` does.
   */
  pauseMs?: number;
  onPause?: (pcm: Int16Array, seq: number) => void;
}

export const DEFAULT_SILENCE_MS = 3000;

export interface UtteranceSegmenter {
  /** Feed one frame; returns the finished utterance's PCM when this frame completed one. */
  push(pcm: Int16Array): Int16Array | null;
  /** True between the first loud frame and the end of the utterance. */
  readonly speaking: boolean;
  /**
   * End the utterance now and return it — but only if nothing loud has been
   * heard since the pause numbered `seq`. A late "finished" verdict must not
   * chop off speech that resumed while it was being worked out.
   */
  cut(seq: number): Int16Array | null;
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
  const pauseSamples = opts.pauseMs === undefined ? Infinity : opts.pauseMs * perMs;

  let preRoll: Int16Array[] = [];
  let preRollLen = 0;
  let chunks: Int16Array[] = [];
  let total = 0;
  let loud = 0; // samples of loud frames in this utterance
  let quiet = 0; // trailing quiet samples
  let speaking = false;
  // Counts loud frames across the session, so a pause can be named by it.
  let heard = 0;
  let paused = false;

  function finish(): Int16Array | null {
    const out = loud >= minSpeechSamples ? concat(chunks) : null;
    chunks = [];
    total = 0;
    loud = 0;
    quiet = 0;
    speaking = false;
    paused = false;
    return out;
  }

  return {
    get speaking(): boolean {
      return speaking;
    },
    cut(seq: number): Int16Array | null {
      if (!speaking || seq !== heard) return null;
      return finish();
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
        heard++;
        paused = false;
      } else {
        quiet += pcm.length;
      }
      if (quiet >= silenceSamples || total >= maxSamples) return finish();
      if (!paused && quiet >= pauseSamples && loud >= minSpeechSamples) {
        paused = true;
        opts.onPause?.(concat(chunks), heard);
      }
      return null;
    },
  };
}

// Speech models invent text from silence and steady noise — "Thank you.",
// "Thanks for watching", "[BLANK_AUDIO]". Dictation mode sends every
// transcript on its own, so these must not become messages.
const PHANTOM_PHRASES = new Set([
  'you',
  'thank you',
  'thanks',
  'thanks for watching',
  'thank you for watching',
  'bye',
  'bye bye',
  'okay',
  'ok',
  'so',
  'uh',
  'um',
  'hmm',
  'mm',
  'mhm',
]);
/** A stock phrase over audio this long is taken to have been said on purpose. */
export const PHANTOM_MAX_MS = 2000;

export function isPhantomTranscript(text: string, audioMs: number): boolean {
  const t = text.trim();
  if (/^[[(*].*[\])*]$/.test(t)) return true;
  const plain = t
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return audioMs < PHANTOM_MAX_MS && PHANTOM_PHRASES.has(plain);
}

/** How much of a clip is loud enough to be speech, in ms — the trailing quiet that ended it does not count. */
export function speechMs(pcm: Int16Array, sampleRate = 16000, threshold = 0.015): number {
  const frame = Math.round(sampleRate / 50); // 20 ms
  let loud = 0;
  for (let i = 0; i < pcm.length; i += frame) {
    if (frameRms(pcm.subarray(i, i + frame)) >= threshold) loud += frame;
  }
  return (loud / sampleRate) * 1000;
}
