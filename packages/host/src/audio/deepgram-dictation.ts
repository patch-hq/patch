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
import { PhraseLedger } from './phrase-ledger.js';
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

interface DeepgramResult {
  type: 'Results';
  start: number;
  duration: number;
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
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
  private readonly ledger: PhraseLedger;
  private interim = '';
  private lastSent = '';
  private finalizeWaiter: (() => void) | null = null;
  private openWaiter: (() => void) | null = null;
  private micFrames = 0;
  private micSamples = 0;
  private micPeak = 0;

  constructor(init: { sessionId: string; chatId: string }, deps: DeepgramDictationDeps) {
    this.sessionId = init.sessionId;
    this.chatId = init.chatId;
    this.deps = deps;
    this.ledger = new PhraseLedger({
      logger: deps.logger,
      sessionId: init.sessionId,
      sendAudio: deps.sendAudio,
      tidyWith: deps.tidyWith,
      label: 'deepgram-dictation',
      isDead: () => this.closed || this.failed,
      onChange: () => this.emit(),
    });
  }

  onSessionStart(): void {
    const key = readKey(this.deps.apiKey);
    if (key === undefined) {
      this.fail('The Deepgram key is no longer set on this host; add it in Settings → Providers');
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
    this.ledger.keep(copy);
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
      // The words run to the end of the audio. The phrase's stretch has to
      // cover them, or Whisper reads a cut that stops short of them and its
      // version of the phrase loses them.
      const end = this.ledger.streamEnd();
      const prev = this.ledger.last();
      const phrase = this.ledger.currentPhrase(prev ? prev.end : 0);
      phrase.pieces.push(this.interim);
      phrase.end = end;
      this.interim = '';
    }
    const last = this.ledger.last();
    if (last && !last.closed) this.ledger.closePhrase(last);
    // Stopping must never make the text worse than the tidied preview: wait
    // for every tidy-up still in flight. Each is bounded by Whisper's own
    // request timeout, and a failed one is reported (never a silent raw swap).
    await this.ledger.settled();
    if (this.failed) return;
    this.deps.sendAudio({
      type: 'audio.transcript_final',
      sessionId: this.sessionId,
      text: this.ledger.text(this.interim),
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
        const phrase = this.ledger.currentPhrase(r.start);
        phrase.pieces.push(transcript);
        phrase.end = r.start + r.duration;
      }
      this.interim = '';
      const phrase = this.ledger.last();
      if (r.speech_final && phrase && !phrase.closed) this.ledger.closePhrase(phrase);
    } else {
      this.interim = transcript;
    }
    this.emit();
    if (r.from_finalize) this.finalizeWaiter?.();
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
