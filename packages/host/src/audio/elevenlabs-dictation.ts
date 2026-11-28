// Dictation on the `elevenlabs` engine (spec/07 § Dictation engines).
//
// Like the deepgram engine, the mic's PCM streams up one WebSocket as it
// arrives and the words come back as they are spoken, so the live text IS the
// transcript: on `audio.dictation_finish` the stream is asked to commit what it
// still holds and its words are the final answer. The `tidy` setting does not
// apply here: Scribe's words are not re-read by Whisper.
//
// NO FALLBACK: a connection that cannot open, a provider error or a quota
// failure is `elevenlabs_unavailable`, and the surface says the dictation
// failed.

import type WebSocket from 'ws';
import type { Logger } from 'pino';
import type { AudioEvent, AudioSessionMode } from '@patch/wire/audio';
import { ScribeRealtimeStream, SCRIBE_MODEL } from './elevenlabs-stt.js';
import type { KeySource } from './keySource.js';
import type { SessionState } from './session.js';
import type { VoiceSessionLike } from './voice-session-like.js';
import type { EngineCosting } from './voiceCost.js';

const SAMPLE_RATE = 16000;
/**
 * Restarts in a row without a stream living for MIN_HEALTHY_MS. A long dictation
 * crosses Scribe's own session limit any number of times, so only a stream that
 * keeps dying at once counts against this.
 */
const MAX_RESTARTS = 3;
const MIN_HEALTHY_MS = 10_000;

export interface ElevenLabsDictationDeps {
  logger: Logger;
  apiKey: KeySource;
  sendAudio: (ev: AudioEvent) => void;
  /** Test seam: the WebSocket constructor and URL. */
  wsCtor?: typeof WebSocket;
  wsUrl?: string;
}

export class ElevenLabsDictationSession implements VoiceSessionLike {
  private readonly sessionId: string;
  private readonly chatId: string;
  private stream: ScribeRealtimeStream | null = null;
  /** Words from streams Scribe has ended; the live stream's words follow them. */
  private carried = '';
  private restarts = 0;
  private audioSecondsEnded = 0;
  private closed = false;
  private failed = false;
  private lastSent = '';
  private micFrames = 0;
  private micSamples = 0;
  private micPeak = 0;

  constructor(
    init: { sessionId: string; chatId: string },
    private readonly deps: ElevenLabsDictationDeps,
  ) {
    this.sessionId = init.sessionId;
    this.chatId = init.chatId;
  }

  onSessionStart(): void {
    // Accepted: the mic is live from here, and audio is held until the stream opens.
    this.deps.sendAudio({ type: 'audio.state', sessionId: this.sessionId, state: 'listening' });
    this.openStream([]);
  }

  private openStream(unsent: Int16Array[]): void {
    const stream = new ScribeRealtimeStream(
      {
        apiKey: this.deps.apiKey,
        logger: this.deps.logger,
        ...(this.deps.wsCtor ? { wsCtor: this.deps.wsCtor } : {}),
        ...(this.deps.wsUrl ? { wsUrl: this.deps.wsUrl } : {}),
      },
      {
        onText: (text) => {
          if (stream === this.stream) this.emit(this.joined(text));
        },
        onError: (m, restartable) => {
          if (stream !== this.stream) return;
          if (restartable && this.restarts < MAX_RESTARTS) this.restart(stream, m);
          else this.fail(m);
        },
      },
    );
    this.stream = stream;
    stream.start();
    for (const pcm of unsent) stream.push(pcm);
  }

  /** Scribe ended the session itself: keep its words, open a new one, resend what it never got. */
  private restart(old: ScribeRealtimeStream, reason: string): void {
    this.restarts = Date.now() - old.startedAt >= MIN_HEALTHY_MS ? 1 : this.restarts + 1;
    this.deps.logger.warn(
      { reason, restarts: this.restarts },
      'scribe dictation: restarting stream',
    );
    this.carried = this.joined(old.text());
    this.audioSecondsEnded += old.audioSeconds;
    this.openStream(old.takeUnsent());
    // The words so far stay on screen while the new stream starts.
    this.emit(this.carried);
  }

  private joined(text: string): string {
    return [this.carried, text].filter((p) => p.length > 0).join(' ');
  }

  async onMicFrame(pcm: Int16Array): Promise<void> {
    if (this.closed || this.failed || !this.stream) return;
    this.micFrames += 1;
    this.micSamples += pcm.length;
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i]!);
      if (a > this.micPeak) this.micPeak = a;
    }
    this.stream.push(pcm);
  }

  /** The user has stopped: commit what Scribe still holds and answer with the whole dictation. */
  async finishDictation(): Promise<void> {
    if (this.closed || this.failed || !this.stream) return;
    // A restart during the commit swaps the stream; commit the new one too.
    let committed: ScribeRealtimeStream;
    do {
      committed = this.stream;
      await committed.commit();
      if (this.failed || this.closed) return;
    } while (committed !== this.stream);
    this.deps.sendAudio({
      type: 'audio.transcript_final',
      sessionId: this.sessionId,
      text: this.joined(this.stream.text()),
    });
  }

  private emit(text: string): void {
    if (this.closed || this.failed || text === this.lastSent) return;
    this.lastSent = text;
    this.deps.sendAudio({ type: 'audio.transcript_partial', sessionId: this.sessionId, text });
  }

  private fail(message: string): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.deps.sendAudio({
      type: 'audio.error',
      code: 'elevenlabs_unavailable',
      message: `Live dictation failed: ${message}`,
      sessionId: this.sessionId,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stream?.close();
  }

  // --- the parts of a voice session dictation has no use for ---------------
  setFocus(): void {}
  setMode(): void {}
  getMode(): AudioSessionMode {
    return 'call';
  }
  getState(): SessionState {
    return this.stream?.isOpen ? 'listening' : 'connecting';
  }
  getCurrentChatId(): string {
    return this.chatId;
  }
  async finalizeNote(): Promise<boolean> {
    throw new Error('an ElevenLabs dictation ends with audio.dictation_finish, not a note commit');
  }
  async injectTranscript(): Promise<void> {
    throw new Error('an ElevenLabs dictation has no transcript seam');
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
    const seconds = this.audioSecondsEnded + (this.stream?.audioSeconds ?? 0);
    return {
      backend: 'local',
      model: SCRIBE_MODEL,
      tokens: null,
      stt: { requests: 1, audioSeconds: seconds, billedSeconds: seconds },
    };
  }
  pushMessage(): void {}

  /** A session with no voice agent holds nothing for the line (only app calls are held). */
  setLine(): void {}
}
