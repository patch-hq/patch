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
    this.stream = new ScribeRealtimeStream(
      {
        apiKey: this.deps.apiKey,
        logger: this.deps.logger,
        ...(this.deps.wsCtor ? { wsCtor: this.deps.wsCtor } : {}),
        ...(this.deps.wsUrl ? { wsUrl: this.deps.wsUrl } : {}),
      },
      { onText: (text) => this.emit(text), onError: (m) => this.fail(m) },
    );
    this.stream.start();
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
    await this.stream.commit();
    if (this.failed) return;
    this.deps.sendAudio({
      type: 'audio.transcript_final',
      sessionId: this.sessionId,
      text: this.stream.text(),
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
    const seconds = this.stream?.audioSeconds ?? 0;
    return {
      backend: 'local',
      model: SCRIBE_MODEL,
      tokens: null,
      stt: { requests: 1, audioSeconds: seconds, billedSeconds: seconds },
    };
  }
  pushContext(): void {}
  isAwaitingHandoff(): boolean {
    return false;
  }
}
