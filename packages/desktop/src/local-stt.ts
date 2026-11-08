// "Parakeet on this computer" dictation, run in the desktop app (spec/07 §
// Dictation engines, `local`).
//
// The same two-model shape the host runs, on this machine: a streaming
// recogniser takes each chunk of the mic once and shows the words as they are
// spoken; when the speaker pauses, the phrase just finished is cut from the
// session's own copy of the audio and read once by the accurate Parakeet TDT
// model, and that version replaces the live words in place. The final is those
// accurate passes joined. Nothing leaves this computer.
//
// This file is the session logic over two engines it is handed (so it is
// testable without a model); `local-stt-workers.ts` is the real sherpa-onnx
// engines. NO FALLBACK: an engine that fails ends the dictation with its
// reason; a phrase whose accurate read failed does not quietly keep its live
// words.

const SAMPLE_RATE = 16000;
/** How long a finish waits for the streaming recogniser to hand over its last words. */
export const LOCAL_FINISH_TIMEOUT_MS = 10_000;

export type LiveEvent =
  | { type: 'text'; text: string }
  | { type: 'phrase'; text: string; startSample: number; endSample: number }
  | { type: 'error'; message: string };

export interface LiveStream {
  accept(pcm: Int16Array): void;
  /** Resolves once the last words have been emitted. */
  finish(): Promise<void>;
  close(): void;
}

export interface LiveEngine {
  open(onEvent: (ev: LiveEvent) => void): LiveStream;
}

export interface AccurateEngine {
  transcribe(pcm: Int16Array): Promise<string>;
}

export type LocalDictationEvent =
  | { type: 'partial'; text: string }
  | { type: 'error'; message: string };

interface Phrase {
  live: string;
  accurate: string | null;
}

export class LocalDictation {
  private readonly stream: LiveStream;
  private readonly accurate: AccurateEngine;
  private readonly emit: (ev: LocalDictationEvent) => void;
  private readonly chunks: Int16Array[] = [];
  private kept = 0;
  private readonly phrases: Phrase[] = [];
  private readonly reads: Promise<void>[] = [];
  private interim = '';
  private lastSent = '';
  private closed = false;
  private failure: string | null = null;

  constructor(live: LiveEngine, accurate: AccurateEngine, emit: (ev: LocalDictationEvent) => void) {
    this.accurate = accurate;
    this.emit = emit;
    this.stream = live.open((ev) => this.onLive(ev));
  }

  push(pcm: Int16Array): void {
    if (this.closed || this.failure !== null) return;
    // COPY: the caller's buffer is reused.
    const copy = pcm.slice();
    this.chunks.push(copy);
    this.kept += copy.length;
    this.stream.accept(copy);
  }

  /** The user has stopped: flush, wait for every accurate read, answer with the whole dictation. */
  async finish(): Promise<string> {
    if (this.closed) throw new Error('the dictation was already closed');
    if (this.failure !== null) throw new Error(this.failure);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), LOCAL_FINISH_TIMEOUT_MS);
    });
    const outcome = await Promise.race([this.stream.finish().then(() => 'done' as const), timeout]);
    clearTimeout(timer);
    if (this.failure !== null) throw new Error(this.failure);
    if (outcome === 'timeout') {
      this.fail('the streaming recogniser did not finish in time');
      throw new Error(this.failure!);
    }
    await Promise.all(this.reads);
    if (this.failure !== null) throw new Error(this.failure);
    return this.text('');
  }

  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.close();
  }

  private text(interim: string): string {
    return [...this.phrases.map((p) => p.accurate ?? p.live), interim]
      .filter((s) => s !== '')
      .join(' ');
  }

  private onLive(ev: LiveEvent): void {
    if (this.closed || this.failure !== null) return;
    if (ev.type === 'error') {
      this.fail(ev.message);
      return;
    }
    if (ev.type === 'text') {
      this.interim = ev.text;
      this.publish();
      return;
    }
    const phrase: Phrase = { live: ev.text, accurate: null };
    this.phrases.push(phrase);
    this.interim = '';
    const clip = this.slice(ev.startSample, ev.endSample);
    this.reads.push(
      this.accurate.transcribe(clip).then(
        (text) => {
          phrase.accurate = text.trim() === '' ? phrase.live : text.trim();
          this.publish();
        },
        (err: Error) => this.fail(`the accurate read of a phrase failed: ${err.message}`),
      ),
    );
    this.publish();
  }

  /** The samples [start, end) of everything pushed so far. */
  private slice(start: number, end: number): Int16Array {
    const to = Math.min(end, this.kept);
    const out = new Int16Array(Math.max(0, to - start));
    let at = 0;
    let offset = 0;
    for (const c of this.chunks) {
      const lo = Math.max(start, offset);
      const hi = Math.min(to, offset + c.length);
      if (hi > lo) {
        out.set(c.subarray(lo - offset, hi - offset), at);
        at += hi - lo;
      }
      offset += c.length;
    }
    return out;
  }

  private publish(): void {
    if (this.closed || this.failure !== null) return;
    const text = this.text(this.interim);
    if (text === this.lastSent) return;
    this.lastSent = text;
    this.emit({ type: 'partial', text });
  }

  private fail(message: string): void {
    if (this.closed || this.failure !== null) return;
    this.failure = `Live dictation failed: ${message}`;
    this.emit({ type: 'error', message: this.failure });
  }
}

export const LOCAL_STT_SAMPLE_RATE = SAMPLE_RATE;
