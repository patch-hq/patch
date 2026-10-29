// Dictation on the `host` engine (spec/07 § Dictation engines).
//
// Two models, each doing the job it is good at, neither re-reading audio for
// the live words:
//   - a streaming recogniser (parakeet-live.ts) takes each chunk of the mic
//     once and keeps its state, so the words appear as they are spoken;
//   - when the speaker pauses, the phrase just finished is cut from the
//     session's own copy of the PCM and read once by the host's accurate
//     offline transcriber (Parakeet TDT), and that version replaces the live
//     words in place.
// The final is those accurate passes joined. Stopping flushes the streaming
// recogniser and waits only for the last phrase's pass, so it can never be
// worse than the preview the user was looking at.
//
// NO FALLBACK: a streaming model that will not load or dies is
// `whisper_unavailable` (the host's own transcriber) and the dictation fails. A failed accurate pass is
// reported the same way and that phrase keeps its live words.

import type { Logger } from 'pino';
import type { AudioEvent, AudioSessionMode } from '@patch/wire/audio';
import type { LiveEvent, LiveRecognizer, LiveStream } from './parakeet-live.js';
import { PhraseLedger } from './phrase-ledger.js';
import type { SessionState } from './session.js';
import type { VoiceSessionLike } from './voice-session-like.js';
import type { EngineCosting } from './voiceCost.js';
import type { WhisperBackend } from './whisper.js';

const SAMPLE_RATE = 16000;
/** How long a finish waits for the streaming recogniser to hand over its last words. */
export const HOST_FINISH_TIMEOUT_MS = 10_000;

export interface HostDictationDeps {
  logger: Logger;
  sendAudio: (ev: AudioEvent) => void;
  live: LiveRecognizer;
  /** The host's accurate transcriber, read once per finished phrase. */
  accurate: WhisperBackend;
}

export class HostDictationSession implements VoiceSessionLike {
  private readonly sessionId: string;
  private readonly chatId: string;
  private readonly deps: HostDictationDeps;
  private readonly ledger: PhraseLedger;
  private stream: LiveStream | null = null;
  private listening = false;
  private closed = false;
  private failed = false;
  private interim = '';
  private lastSent = '';
  private micFrames = 0;
  private micSamples = 0;
  private micPeak = 0;

  constructor(init: { sessionId: string; chatId: string }, deps: HostDictationDeps) {
    this.sessionId = init.sessionId;
    this.chatId = init.chatId;
    this.deps = deps;
    this.ledger = new PhraseLedger({
      logger: deps.logger,
      sessionId: init.sessionId,
      sendAudio: deps.sendAudio,
      tidyWith: deps.accurate,
      label: 'host-dictation',
      isDead: () => this.closed || this.failed,
      onChange: () => this.emit(),
    });
  }

  onSessionStart(): void {
    this.listening = true;
    this.deps.sendAudio({ type: 'audio.state', sessionId: this.sessionId, state: 'listening' });
    this.stream = this.deps.live.open((ev) => this.onLive(ev));
  }

  async onMicFrame(pcm: Int16Array): Promise<void> {
    if (this.closed || this.failed || !this.stream) return;
    this.micFrames += 1;
    this.micSamples += pcm.length;
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i]!);
      if (a > this.micPeak) this.micPeak = a;
    }
    // COPY: the caller's buffer is reused.
    const copy = pcm.slice();
    this.ledger.keep(copy);
    this.stream.accept(copy);
  }

  /**
   * The user has stopped: flush the streaming recogniser, wait for the last
   * phrase's accurate read, and answer with the whole dictation.
   */
  async finishDictation(): Promise<void> {
    if (this.closed || this.failed || !this.stream) return;
    const timeout = new Promise<'timeout'>((r) =>
      setTimeout(() => r('timeout'), HOST_FINISH_TIMEOUT_MS),
    );
    const outcome = await Promise.race([this.stream.finish().then(() => 'done' as const), timeout]);
    if (this.failed) return;
    if (outcome === 'timeout') {
      this.fail('the streaming recogniser did not finish in time');
      return;
    }
    // Stopping must never make the text worse than the preview: wait for every
    // accurate read in flight. Each is bounded by the transcriber's own timeout,
    // and a failed one is reported (never a silent swap to the live words).
    await this.ledger.settled();
    if (this.failed || this.closed) return;
    this.deps.sendAudio({
      type: 'audio.transcript_final',
      sessionId: this.sessionId,
      text: this.ledger.text(''),
    });
  }

  private onLive(ev: LiveEvent): void {
    if (this.closed || this.failed) return;
    if (ev.type === 'error') {
      this.fail(ev.message);
      return;
    }
    if (ev.type === 'text') {
      this.interim = ev.text;
      this.emit();
      return;
    }
    const phrase = this.ledger.currentPhrase(ev.startSample / SAMPLE_RATE);
    phrase.pieces.push(ev.text);
    phrase.end = ev.endSample / SAMPLE_RATE;
    this.interim = '';
    this.ledger.closePhrase(phrase);
    this.emit();
  }

  private emit(): void {
    if (this.closed || this.failed) return;
    const text = this.ledger.text(this.interim);
    if (text === this.lastSent) return;
    this.lastSent = text;
    this.deps.sendAudio({ type: 'audio.transcript_partial', sessionId: this.sessionId, text });
  }

  private fail(message: string): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.deps.logger.error({ sessionId: this.sessionId, err: message }, 'host-dictation');
    this.deps.sendAudio({
      type: 'audio.error',
      code: 'whisper_unavailable',
      message: `Live dictation failed: ${message}`,
      sessionId: this.sessionId,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stream?.close();
    this.stream = null;
  }

  // --- the parts of a voice session dictation has no use for ---------------
  setFocus(): void {}
  setMode(): void {}
  getMode(): AudioSessionMode {
    return 'call';
  }
  getState(): SessionState {
    return this.listening ? 'listening' : 'connecting';
  }
  getCurrentChatId(): string {
    return this.chatId;
  }
  async finalizeNote(): Promise<boolean> {
    throw new Error('a host dictation ends with audio.dictation_finish, not a note commit');
  }
  async injectTranscript(): Promise<void> {
    throw new Error('a host dictation has no transcript seam');
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
    return { backend: 'local', model: 'parakeet', tokens: null, stt: null };
  }
  pushContext(): void {}
  isAwaitingHandoff(): boolean {
    return false;
  }
}
