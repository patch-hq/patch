// Dictation on the `deepgram` engine (spec/07 § Dictation engines).
//
// Every other dictation engine is request/response: the live words come from
// re-reading the whole recording so far, about once a second and rationed by
// the provider's request limit. Deepgram streams. The mic's PCM goes up one
// WebSocket as it arrives and the words come back as they are spoken, so the
// live text IS the transcript: on `audio.dictation_finish` the stream is
// flushed and its words are the final answer, with nothing transcribed again.
//
// Tidy-up (`voiceConfig.dictation.tidy`): Deepgram marks the end of each
// utterance (`speech_final`, after a short pause). That phrase's audio is cut
// from the session's own copy of the PCM, using Deepgram's own timestamps, and
// read once by Whisper. Whisper's text replaces the phrase in place while the
// user carries on talking, so by the time they stop only the last phrase is
// left to tidy.
//
// NO FALLBACK: a connection that cannot open or dies mid-dictation is
// `deepgram_unavailable`, and the surface says the dictation failed. A failed
// tidy-up is reported (`whisper_unavailable`) and the phrase keeps Deepgram's
// words, which are already the user's words.

import WebSocket from 'ws';
import type { Logger } from 'pino';
import type { AudioEvent, AudioSessionMode } from '@patch/wire/audio';
import { DEEPGRAM_MODEL } from './hosted-stt.js';
import { readKey, type KeySource } from './keySource.js';
import { isStockHallucination } from './partial-filter.js';
import type { SessionState } from './session.js';
import type { VoiceSessionLike } from './voice-session-like.js';
import type { EngineCosting } from './voiceCost.js';
import type { WhisperBackend } from './whisper.js';

const SAMPLE_RATE = 16000;
const DEEPGRAM_LISTEN_WSS = 'wss://api.deepgram.com/v1/listen';
/** Quiet this long ends an utterance (Deepgram `endpointing`), and starts its tidy-up. */
const ENDPOINTING_MS = 300;
/** How long a finish waits for Deepgram to flush its last words. */
export const FINALIZE_TIMEOUT_MS = 3000;
/** How long a finish waits for the tidy-up of the phrases still in flight. */
export const TIDY_WAIT_MS = 6000;
/** Audio kept either side of a phrase's own timestamps, so Whisper hears its edges. */
const TIDY_PAD_S = 0.25;
/** Audio held for tidy-up. Past this the oldest goes, and so does its tidy-up. */
const MAX_KEPT_SECONDS = 30 * 60;

interface DeepgramResult {
  type: 'Results';
  start: number;
  duration: number;
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
}

interface Phrase {
  /** Seconds from the start of the stream. */
  start: number;
  end: number;
  /** Deepgram's finished pieces of it. */
  pieces: string[];
  /** Whisper's version, once it has answered. */
  tidied?: string;
  /** Deepgram has called the utterance over. */
  closed: boolean;
}

export interface DeepgramDictationDeps {
  logger: Logger;
  apiKey: KeySource;
  sendAudio: (ev: AudioEvent) => void;
  /** The host's Whisper, for tidy-up. Undefined: tidy-up is off. */
  tidyWith?: WhisperBackend;
  /** Test seam: the WebSocket constructor and URL. */
  wsCtor?: typeof WebSocket;
  wsUrl?: string;
}

export class DeepgramDictationSession implements VoiceSessionLike {
  private readonly sessionId: string;
  private readonly chatId: string;
  private readonly deps: DeepgramDictationDeps;
  private ws: WebSocket | null = null;
  private open = false;
  private closed = false;
  private failed = false;
  private readonly pending: Buffer[] = [];
  private readonly phrases: Phrase[] = [];
  private interim = '';
  private lastSent = '';
  /** Every PCM chunk this session received, for cutting phrases out. */
  private readonly kept: Int16Array[] = [];
  /** Samples dropped off the front of `kept` once it outgrew its cap. */
  private droppedSamples = 0;
  private keptSamples = 0;
  private readonly tidying = new Set<Promise<void>>();
  private tidyReported = false;
  private finalizeWaiter: (() => void) | null = null;
  private openWaiter: (() => void) | null = null;
  private micFrames = 0;
  private micSamples = 0;
  private micPeak = 0;

  constructor(init: { sessionId: string; chatId: string }, deps: DeepgramDictationDeps) {
    this.sessionId = init.sessionId;
    this.chatId = init.chatId;
    this.deps = deps;
  }

  onSessionStart(): void {
    const key = readKey(this.deps.apiKey);
    if (key === undefined) {
      this.fail('DEEPGRAM_API_KEY is no longer set on this host');
      return;
    }
    // Accepted: the mic is live from here, and audio is held until the stream
    // opens — the same 'listening' the host's own pipeline says on start.
    this.deps.sendAudio({ type: 'audio.state', sessionId: this.sessionId, state: 'listening' });
    const params = new URLSearchParams({
      model: DEEPGRAM_MODEL,
      language: 'en',
      encoding: 'linear16',
      sample_rate: String(SAMPLE_RATE),
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      endpointing: String(ENDPOINTING_MS),
    });
    const Ctor = this.deps.wsCtor ?? WebSocket;
    const ws = new Ctor(`${this.deps.wsUrl ?? DEEPGRAM_LISTEN_WSS}?${params.toString()}`, {
      headers: { Authorization: `Token ${key}` },
    });
    this.ws = ws;
    ws.on('open', () => {
      if (this.closed) {
        ws.close();
        return;
      }
      this.open = true;
      for (const b of this.pending.splice(0)) ws.send(b);
      this.openWaiter?.();
    });
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      let msg: { type?: string };
      try {
        msg = JSON.parse(String(data)) as { type?: string };
      } catch (err) {
        this.fail(`unreadable message from Deepgram: ${(err as Error).message}`);
        return;
      }
      if (msg.type === 'Results') this.onResult(msg as DeepgramResult);
    });
    ws.on('unexpected-response', (_req, res) => {
      this.fail(`Deepgram refused the connection (HTTP ${res.statusCode ?? '?'})`);
    });
    ws.on('error', (err: Error) => this.fail(`Deepgram connection failed: ${err.message}`));
    ws.on('close', (code: number, reason: Buffer) => {
      this.open = false;
      this.finalizeWaiter?.();
      this.openWaiter?.();
      if (!this.closed) {
        this.fail(
          `Deepgram closed the connection (${code}${reason.length ? `: ${String(reason)}` : ''})`,
        );
      }
    });
  }

  async onMicFrame(pcm: Int16Array): Promise<void> {
    if (this.closed || this.failed) return;
    this.micFrames += 1;
    this.micSamples += pcm.length;
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i]!);
      if (a > this.micPeak) this.micPeak = a;
    }
    // COPY: the caller's buffer is reused.
    const copy = pcm.slice();
    if (this.deps.tidyWith) this.keep(copy);
    const bytes = Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength);
    if (this.open) this.ws!.send(bytes);
    else this.pending.push(bytes);
  }

  /**
   * The user has stopped: flush Deepgram, close the last phrase, wait for the
   * tidy-ups in flight, and answer with the whole dictation.
   */
  async finishDictation(): Promise<void> {
    if (this.closed || this.failed) return;
    // A quick dictation can end before the stream has opened: its audio is
    // held in `pending`, so wait for the stream rather than answer with nothing.
    if (!this.open) {
      await this.waitFor(
        (done) => (this.openWaiter = done),
        () => (this.openWaiter = null),
      );
      if (this.failed) return;
      if (!this.open) {
        this.fail('the connection to Deepgram did not open in time');
        return;
      }
    }
    await this.waitFor(
      (done) => {
        this.finalizeWaiter = done;
        this.ws!.send(JSON.stringify({ type: 'Finalize' }));
      },
      () => (this.finalizeWaiter = null),
    );
    if (this.failed) return;
    // Anything Deepgram had not finalised by now is still what was heard.
    if (this.interim) {
      this.currentPhrase(this.phraseEnd()).pieces.push(this.interim);
      this.interim = '';
    }
    const last = this.phrases[this.phrases.length - 1];
    if (last && !last.closed) this.closePhrase(last);
    if (this.tidying.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.tidying]),
        new Promise((r) => setTimeout(r, TIDY_WAIT_MS)),
      ]);
    }
    if (this.failed) return;
    this.deps.sendAudio({
      type: 'audio.transcript_final',
      sessionId: this.sessionId,
      text: this.text(),
    });
  }

  /** Resolve when `arm`'s callback is called, or after FINALIZE_TIMEOUT_MS. */
  private waitFor(arm: (done: () => void) => void, disarm: () => void): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        disarm();
        resolve();
      };
      const timer = setTimeout(done, FINALIZE_TIMEOUT_MS);
      arm(done);
    });
  }

  private onResult(r: DeepgramResult): void {
    const transcript = (r.channel?.alternatives?.[0]?.transcript ?? '').trim();
    if (r.is_final) {
      if (transcript) {
        const phrase = this.currentPhrase(r.start);
        phrase.pieces.push(transcript);
        phrase.end = r.start + r.duration;
      }
      this.interim = '';
      const phrase = this.phrases[this.phrases.length - 1];
      if (r.speech_final && phrase && !phrase.closed) this.closePhrase(phrase);
    } else {
      this.interim = transcript;
    }
    this.emit();
    if (r.from_finalize) this.finalizeWaiter?.();
  }

  private currentPhrase(start: number): Phrase {
    const last = this.phrases[this.phrases.length - 1];
    if (last && !last.closed) return last;
    const phrase: Phrase = { start, end: start, pieces: [], closed: false };
    this.phrases.push(phrase);
    return phrase;
  }

  private phraseEnd(): number {
    return (this.droppedSamples + this.keptSamples) / SAMPLE_RATE;
  }

  private closePhrase(phrase: Phrase): void {
    phrase.closed = true;
    const tidy = this.deps.tidyWith;
    if (!tidy || phrase.pieces.length === 0) return;
    const pcm = this.cut(phrase.start - TIDY_PAD_S, phrase.end + TIDY_PAD_S);
    if (pcm === null) return;
    const job = tidy
      .transcribe(pcm, { priority: 'final' })
      .then((text) => {
        const t = text.trim();
        if (this.closed || t.length === 0 || isStockHallucination(t)) return;
        phrase.tidied = t;
        this.emit();
      })
      .catch((err: Error) => {
        this.deps.logger.error(
          { sessionId: this.sessionId, err: err.message },
          'deepgram-dictation: tidy-up failed; the phrase keeps the live words',
        );
        if (this.tidyReported || this.closed) return;
        this.tidyReported = true;
        this.deps.sendAudio({
          type: 'audio.error',
          code: 'whisper_unavailable',
          message: `Tidying up with Whisper failed (${err.message}); the live words stand.`,
          sessionId: this.sessionId,
        });
      });
    const tracked: Promise<void> = job.finally(() => this.tidying.delete(tracked));
    this.tidying.add(tracked);
  }

  private keep(pcm: Int16Array): void {
    this.kept.push(pcm);
    this.keptSamples += pcm.length;
    while (this.keptSamples > MAX_KEPT_SECONDS * SAMPLE_RATE && this.kept.length > 1) {
      const gone = this.kept.shift()!;
      this.keptSamples -= gone.length;
      this.droppedSamples += gone.length;
    }
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

  private text(): string {
    const parts = this.phrases.map((p) => p.tidied ?? p.pieces.join(' '));
    if (this.interim) parts.push(this.interim);
    return parts.filter((p) => p.length > 0).join(' ');
  }

  private emit(): void {
    if (this.closed || this.failed) return;
    const text = this.text();
    if (text === this.lastSent) return;
    this.lastSent = text;
    this.deps.sendAudio({ type: 'audio.transcript_partial', sessionId: this.sessionId, text });
  }

  private fail(message: string): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.finalizeWaiter?.();
    this.openWaiter?.();
    this.deps.logger.error({ sessionId: this.sessionId, err: message }, 'deepgram-dictation');
    this.deps.sendAudio({
      type: 'audio.error',
      code: 'deepgram_unavailable',
      message: `Live dictation failed: ${message}`,
      sessionId: this.sessionId,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.finalizeWaiter?.();
    const ws = this.ws;
    if (ws && this.open) {
      try {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        // already going; close below is the source of truth
      }
    }
    ws?.close();
  }

  // --- the parts of a voice session dictation has no use for ---------------
  setFocus(): void {}
  setMode(): void {}
  getMode(): AudioSessionMode {
    return 'call';
  }
  getState(): SessionState {
    return this.open ? 'listening' : 'connecting';
  }
  getCurrentChatId(): string {
    return this.chatId;
  }
  async finalizeNote(): Promise<boolean> {
    throw new Error('a Deepgram dictation ends with audio.dictation_finish, not a note commit');
  }
  async injectTranscript(): Promise<void> {
    throw new Error('a Deepgram dictation has no transcript seam');
  }
  async speak(): Promise<void> {
    throw new Error('a dictation session does not speak');
  }
  stats(): {
    micFrames: number;
    micSeconds: number;
    vadEvents: number;
    turns: number;
    micPeakDbfs: number;
  } {
    return {
      micFrames: this.micFrames,
      micSeconds: this.micSamples / SAMPLE_RATE,
      vadEvents: 0,
      turns: 0,
      micPeakDbfs: this.micPeak === 0 ? -Infinity : 20 * Math.log10(this.micPeak / 32768),
    };
  }
  engineCosting(): EngineCosting {
    return { backend: 'local', model: DEEPGRAM_MODEL, tokens: null, stt: null };
  }
  pushContext(): void {}
  isAwaitingHandoff(): boolean {
    return false;
  }
}
