// The phrases of a live dictation and their tidy-up (spec/07 § Dictation
// engines). Shared by the streaming engines: whatever hears the words live
// (Deepgram, the host's streaming model) reports each finished piece with its
// stretch of the stream, and this keeps the session's own copy of the PCM so a
// finished phrase can be cut out and read once, accurately, by the host's
// transcriber. That version replaces the live words in place, so by the time
// the speaker stops only the last phrase is left, and the final is the
// phrases joined.
//
// A failed tidy-up is reported once (`whisper_unavailable`) and the phrase
// keeps its live words; it is never silent.

import type { Logger } from 'pino';
import type { AudioEvent } from '@patch/wire/audio';
import { isStockHallucination } from './partial-filter.js';
import type { WhisperBackend } from './whisper.js';

const SAMPLE_RATE = 16000;
/** Audio kept either side of a phrase's own timestamps, so the read hears its edges. */
const TIDY_PAD_S = 0.25;
/** Audio held for tidy-up. Past this the oldest goes, and so does its tidy-up. */
const MAX_KEPT_SECONDS = 30 * 60;

export interface Phrase {
  /** Seconds from the start of the stream. */
  start: number;
  end: number;
  /** The live engine's finished pieces of it. */
  pieces: string[];
  /** The accurate read, once it has answered. */
  tidied?: string;
  /** The live engine has called the utterance over. */
  closed: boolean;
}

export interface PhraseLedgerDeps {
  logger: Logger;
  sessionId: string;
  sendAudio: (ev: AudioEvent) => void;
  /** The host's transcriber. Undefined: no tidy-up. */
  tidyWith: WhisperBackend | undefined;
  /** Log prefix, e.g. `deepgram-dictation`. */
  label: string;
  /** The session is over or failed: nothing more may be sent. */
  isDead: () => boolean;
  /** A phrase's text changed. */
  onChange: () => void;
}

export class PhraseLedger {
  readonly phrases: Phrase[] = [];
  private readonly deps: PhraseLedgerDeps;
  /** Every PCM chunk this session received, for cutting phrases out. */
  private readonly kept: Int16Array[] = [];
  /** Samples dropped off the front of `kept` once it outgrew its cap. */
  private droppedSamples = 0;
  private keptSamples = 0;
  private readonly tidying = new Set<Promise<void>>();
  private tidyReported = false;

  constructor(deps: PhraseLedgerDeps) {
    this.deps = deps;
  }

  /** Hold a chunk (already a copy) for cutting phrases out. No-op without a tidy-up. */
  keep(pcm: Int16Array): void {
    if (!this.deps.tidyWith) return;
    this.kept.push(pcm);
    this.keptSamples += pcm.length;
    while (this.keptSamples > MAX_KEPT_SECONDS * SAMPLE_RATE && this.kept.length > 1) {
      const gone = this.kept.shift()!;
      this.keptSamples -= gone.length;
      this.droppedSamples += gone.length;
    }
  }

  /** Seconds of audio received so far. */
  streamEnd(): number {
    return (this.droppedSamples + this.keptSamples) / SAMPLE_RATE;
  }

  last(): Phrase | undefined {
    return this.phrases[this.phrases.length - 1];
  }

  /** The open phrase, or a new one starting at `start`. */
  currentPhrase(start: number): Phrase {
    const last = this.last();
    if (last && !last.closed) return last;
    const phrase: Phrase = { start, end: start, pieces: [], closed: false };
    this.phrases.push(phrase);
    return phrase;
  }

  /** The phrase is over: read it once, accurately, while the speaker carries on. */
  closePhrase(phrase: Phrase): void {
    phrase.closed = true;
    const tidy = this.deps.tidyWith;
    if (!tidy || phrase.pieces.length === 0) return;
    const pcm = this.cut(phrase.start - TIDY_PAD_S, phrase.end + TIDY_PAD_S);
    if (pcm === null) return;
    const job = tidy
      .transcribe(pcm, { priority: 'final' })
      .then((text) => {
        const t = text.trim();
        if (this.deps.isDead() || t.length === 0 || isStockHallucination(t)) return;
        phrase.tidied = t;
        this.deps.onChange();
      })
      .catch((err: Error) => {
        this.deps.logger.error(
          { sessionId: this.deps.sessionId, err: err.message },
          `${this.deps.label}: tidy-up failed; the phrase keeps the live words`,
        );
        if (this.tidyReported || this.deps.isDead()) return;
        this.tidyReported = true;
        this.deps.sendAudio({
          type: 'audio.error',
          code: 'whisper_unavailable',
          message: `Tidying up with Whisper failed (${err.message}); the live words stand.`,
          sessionId: this.deps.sessionId,
        });
      });
    const tracked: Promise<void> = job.finally(() => this.tidying.delete(tracked));
    this.tidying.add(tracked);
  }

  /** Every tidy-up in flight has answered. Each is bounded by the transcriber's own timeout. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.tidying]);
  }

  /** The dictation so far: each phrase as tidied if it has been, plus the words still interim. */
  text(interim: string): string {
    const parts = this.phrases.map((p) => p.tidied ?? p.pieces.join(' '));
    if (interim) parts.push(interim);
    return parts.filter((p) => p.length > 0).join(' ');
  }

  /** The kept PCM between two stream times, or null when it has been dropped. */
  private cut(fromS: number, toS: number): Int16Array | null {
    const from = Math.max(0, Math.floor(fromS * SAMPLE_RATE)) - this.droppedSamples;
    const to = Math.min(this.droppedSamples + this.keptSamples, Math.ceil(toS * SAMPLE_RATE));
    const end = to - this.droppedSamples;
    if (from < 0 || end <= from) return null;
    const out = new Int16Array(end - from);
    let pos = 0;
    let written = 0;
    for (const chunk of this.kept) {
      const cStart = pos;
      const cEnd = pos + chunk.length;
      pos = cEnd;
      if (cEnd <= from) continue;
      if (cStart >= end) break;
      const a = Math.max(from, cStart) - cStart;
      const b = Math.min(end, cEnd) - cStart;
      out.set(chunk.subarray(a, b), written);
      written += b - a;
    }
    return out;
  }
}
