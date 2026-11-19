// ElevenLabs Scribe as a speech-to-text engine (spec/07 § Dictation engines).
//
// Two shapes, both on the same key (`ELEVEN_LABS_API_KEY`):
//   - ElevenLabsScribeBackend — a WhisperBackend. One request per clip
//     (`POST /v1/speech-to-text`, scribe_v2). Selected for the local voice tier
//     with the speech setting `elevenlabs`, and used to read a voice-note clip when
//     dictation is on the `elevenlabs` engine. It also offers `openLiveStream`,
//     so the voice tier's live words stream instead of re-reading the prefix
//     (re-reading would bill the growing prefix again every second).
//   - ScribeRealtimeStream — the realtime WebSocket (`scribe_v2_realtime`).
//     PCM goes up as it arrives; partial and committed text come back.
//
// NO FALLBACK: a missing key, a refused connection, a provider error or a
// quota failure is an error that reaches the user. Nothing here answers with
// another provider.

import WebSocket from 'ws';
import type { Logger } from 'pino';
import { pcm16ToWav, type LiveTranscriptStream, type WhisperBackend } from './whisper.js';
import { readKey, type KeySource } from './keySource.js';

export const SCRIBE_MODEL = 'scribe_v2';
export const SCRIBE_REALTIME_MODEL = 'scribe_v2_realtime';
const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const SCRIBE_REALTIME_WSS = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const SAMPLE_RATE = 16000;
/** How long a commit waits for Scribe to hand back the last words. */
export const SCRIBE_COMMIT_TIMEOUT_MS = 3000;
/**
 * Scribe ends a session (`queue_overflow`) when audio arrives faster than real
 * time. Backlogged audio (a phone reconnecting and flushing what it held) is
 * therefore paced: at most this many seconds of audio per second of wall clock,
 * after a one-second head start. Slightly over 1 so a backlog drains while the
 * live mic keeps arriving.
 */
export const SCRIBE_SEND_RATE = 1.25;
const SCRIBE_SEND_LEAD_MS = 1000;
/** How long a commit waits for the paced backlog to be sent before giving up. */
const SCRIBE_DRAIN_TIMEOUT_MS = 60_000;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Thrown for a failed Scribe request. */
export class ScribeError extends Error {
  override readonly name = 'ScribeError';
}

/**
 * Server messages that end the stream's usefulness. `commit_throttled` and
 * `insufficient_audio_activity` only mean "nothing new to commit" and are not
 * failures.
 */
const NOTHING_TO_COMMIT = new Set(['commit_throttled', 'insufficient_audio_activity']);

/**
 * Messages by which Scribe ends one session while the user is still talking.
 * Dictation has no length limit of its own, so these open a new session
 * rather than ending the dictation.
 */
const RESTARTABLE_ENDS = new Set(['queue_overflow', 'session_time_limit_exceeded']);

export interface ScribeStreamDeps {
  apiKey: KeySource;
  logger: Logger;
  /** Test seam: the WebSocket constructor and URL. */
  wsCtor?: typeof WebSocket;
  wsUrl?: string;
}

/**
 * One realtime Scribe connection. `text` is every committed piece plus the
 * partial in progress; `onText` fires when it changes.
 */
export class ScribeRealtimeStream implements LiveTranscriptStream {
  private ws: WebSocket | null = null;
  private open = false;
  private closed = false;
  private failed = false;
  /** Audio not yet sent, paced to real time (see SCRIBE_SEND_RATE). */
  private readonly queue: Int16Array[] = [];
  private sentSamples = 0;
  private paceStart = 0;
  private paceTimer: ReturnType<typeof setTimeout> | null = null;
  private drainWaiter: (() => void) | null = null;
  private readonly committed: string[] = [];
  private partial = '';
  private lastText = '';
  private commitWaiter: (() => void) | null = null;
  private openWaiter: (() => void) | null = null;
  private samples = 0;

  constructor(
    private readonly deps: ScribeStreamDeps,
    private readonly handlers: {
      onText: (text: string) => void;
      /** `restartable`: Scribe ended this session itself; a new one may be opened. */
      onError: (message: string, restartable?: boolean) => void;
    },
  ) {}

  /** Audio seconds sent so far — what the provider bills. */
  get audioSeconds(): number {
    return this.samples / SAMPLE_RATE;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** When this connection was opened (ms since epoch). */
  readonly startedAt = Date.now();

  get hasFailed(): boolean {
    return this.failed;
  }

  text(): string {
    return [...this.committed, this.partial].filter((p) => p.length > 0).join(' ');
  }

  start(): void {
    const key = readKey(this.deps.apiKey);
    if (key === undefined) {
      this.fail('ELEVEN_LABS_API_KEY is no longer set on this host');
      return;
    }
    const params = new URLSearchParams({
      model_id: SCRIBE_REALTIME_MODEL,
      audio_format: 'pcm_16000',
      commit_strategy: 'vad',
      // Commit a phrase after half a second of quiet (default 1.5 s) so words settle sooner.
      vad_silence_threshold_secs: '0.5',
      language_code: 'en',
    });
    const Ctor = this.deps.wsCtor ?? WebSocket;
    const ws = new Ctor(`${this.deps.wsUrl ?? SCRIBE_REALTIME_WSS}?${params.toString()}`, {
      headers: { 'xi-api-key': key },
    });
    this.ws = ws;
    ws.on('open', () => {
      if (this.closed) {
        ws.close();
        return;
      }
      this.open = true;
      this.drain();
      this.openWaiter?.();
    });
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      let msg: { message_type?: string; text?: string; error?: string };
      try {
        msg = JSON.parse(String(data)) as typeof msg;
      } catch (err) {
        this.fail(`unreadable message from ElevenLabs: ${(err as Error).message}`);
        return;
      }
      this.onMessage(msg);
    });
    ws.on('unexpected-response', (_req, res) => {
      this.fail(`ElevenLabs refused the connection (HTTP ${res.statusCode ?? '?'})`);
    });
    ws.on('error', (err: Error) => this.fail(`ElevenLabs connection failed: ${err.message}`));
    ws.on('close', (code: number, reason: Buffer) => {
      this.open = false;
      this.commitWaiter?.();
      this.openWaiter?.();
      if (!this.closed) {
        this.fail(
          `ElevenLabs closed the connection (${code}${reason.length ? `: ${String(reason)}` : ''})`,
          true,
        );
      }
    });
  }

  private onMessage(msg: { message_type?: string; text?: string; error?: string }): void {
    const type = msg.message_type ?? '';
    if (type === 'partial_transcript') {
      this.partial = (msg.text ?? '').trim();
      this.emit();
    } else if (type === 'committed_transcript') {
      const t = (msg.text ?? '').trim();
      if (t) this.committed.push(t);
      this.partial = '';
      this.emit();
      this.commitWaiter?.();
    } else if (NOTHING_TO_COMMIT.has(type)) {
      this.deps.logger.warn({ type }, 'scribe: nothing to commit');
      this.commitWaiter?.();
    } else if (RESTARTABLE_ENDS.has(type)) {
      // Scribe ended this session itself; the dictation opens a new one.
      this.fail(`ElevenLabs reported ${type}: ${msg.error ?? 'no detail'}`, true);
    } else if (type === 'error' || type.endsWith('_error') || msg.error !== undefined) {
      this.fail(`ElevenLabs reported ${type || 'an error'}: ${msg.error ?? 'no detail'}`);
    } else if (
      type === 'quota_exceeded' ||
      type === 'rate_limited' ||
      type === 'resource_exhausted'
    ) {
      this.fail(`ElevenLabs reported ${type}`);
    }
  }

  push(pcm: Int16Array): void {
    if (this.closed || this.failed) return;
    this.samples += pcm.length;
    this.queue.push(pcm);
    this.drain();
  }

  /** Audio that was queued but never sent: carried to the next session after a restart. */
  takeUnsent(): Int16Array[] {
    return this.queue.splice(0);
  }

  /** Sends queued audio up to the real-time budget, and schedules the rest. */
  private drain(): void {
    if (this.paceTimer) {
      clearTimeout(this.paceTimer);
      this.paceTimer = null;
    }
    if (!this.open || this.closed || this.failed) return;
    if (this.paceStart === 0) this.paceStart = Date.now();
    const budget = ((Date.now() - this.paceStart + SCRIBE_SEND_LEAD_MS) / 1000) * SAMPLE_RATE;
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      if (this.sentSamples > 0 && this.sentSamples + next.length > budget * SCRIBE_SEND_RATE) break;
      this.queue.shift();
      this.sentSamples += next.length;
      this.ws!.send(
        JSON.stringify({
          message_type: 'input_audio_chunk',
          audio_base_64: Buffer.from(next.buffer, next.byteOffset, next.byteLength).toString(
            'base64',
          ),
          commit: false,
          sample_rate: SAMPLE_RATE,
        }),
      );
    }
    if (this.queue.length > 0) {
      this.paceTimer = setTimeout(() => this.drain(), 50);
    } else {
      this.drainWaiter?.();
    }
  }

  /**
   * Ask for whatever is still uncommitted and wait (up to the timeout) for it.
   * Anything not committed by then stays as the partial, which is still what
   * was heard.
   */
  async commit(): Promise<void> {
    if (this.closed || this.failed) return;
    if (!this.open) {
      await this.waitFor(
        (done) => (this.openWaiter = done),
        () => (this.openWaiter = null),
      );
      if (this.failed) return;
      if (!this.open) {
        this.fail('the connection to ElevenLabs did not open in time');
        return;
      }
    }
    // Audio still being paced out must reach Scribe before the commit does.
    if (this.queue.length > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, SCRIBE_DRAIN_TIMEOUT_MS);
        function done(): void {
          clearTimeout(timer);
          resolve();
        }
        this.drainWaiter = done;
      });
      this.drainWaiter = null;
      if (this.closed || this.failed) return;
      if (this.queue.length > 0) {
        this.fail('the audio backlog did not reach ElevenLabs in time');
        return;
      }
    }
    await this.waitFor(
      (done) => {
        this.commitWaiter = done;
        this.send({
          message_type: 'input_audio_chunk',
          audio_base_64: '',
          commit: true,
          sample_rate: SAMPLE_RATE,
        });
      },
      () => (this.commitWaiter = null),
    );
    // Whatever Scribe had not committed is still what was heard.
    if (this.partial) {
      this.committed.push(this.partial);
      this.partial = '';
      this.emit();
    }
  }

  private waitFor(arm: (done: () => void) => void, disarm: () => void): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        disarm();
        resolve();
      };
      const timer = setTimeout(done, SCRIBE_COMMIT_TIMEOUT_MS);
      arm(done);
    });
  }

  private send(msg: object): void {
    const raw = JSON.stringify(msg);
    if (!this.open) throw new Error('scribe: send before the connection opened');
    this.ws!.send(raw);
  }

  private emit(): void {
    if (this.closed || this.failed) return;
    const text = this.text();
    if (text === this.lastText) return;
    this.lastText = text;
    this.handlers.onText(text);
  }

  private fail(message: string, restartable = false): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    if (this.paceTimer) clearTimeout(this.paceTimer);
    this.commitWaiter?.();
    this.openWaiter?.();
    this.drainWaiter?.();
    this.deps.logger.error({ err: message }, 'scribe-realtime');
    this.handlers.onError(message, restartable);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.paceTimer) clearTimeout(this.paceTimer);
    this.drainWaiter?.();
    this.commitWaiter?.();
    this.ws?.close();
  }
}

export interface ScribeBackendOptions {
  logger: Logger;
  /** Resolved per request (keySource.ts), so a changed key applies to the next clip. */
  apiKey: KeySource;
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: FetchLike;
  wsCtor?: typeof WebSocket;
  wsUrl?: string;
}

interface ScribeWord {
  text?: unknown;
  type?: unknown;
  speaker_id?: unknown;
}

/** One stretch of a diarised clip, by Scribe's per-request speaker id. */
export interface ScribeSpeakerRun {
  speakerId: string;
  text: string;
}

/**
 * Groups Scribe's word list into consecutive runs by speaker. Audio events
 * ("(laughter)") stay in the text, in the speaker's run, so notes keep them.
 */
export function scribeSpeakerRuns(words: ScribeWord[]): ScribeSpeakerRun[] {
  const runs: ScribeSpeakerRun[] = [];
  for (const w of words) {
    if (typeof w.text !== 'string')
      throw new ScribeError('ElevenLabs returned a word with no text');
    if (w.type === 'spacing') {
      const last = runs[runs.length - 1];
      if (last) last.text += w.text;
      continue;
    }
    if (typeof w.speaker_id !== 'string') {
      throw new ScribeError('ElevenLabs returned a word with no speaker_id');
    }
    const last = runs[runs.length - 1];
    if (last && last.speakerId === w.speaker_id) last.text += w.text;
    else runs.push({ speakerId: w.speaker_id, text: w.text });
  }
  return runs.map((r) => ({ ...r, text: r.text.trim() })).filter((r) => r.text !== '');
}

/**
 * Scribe numbers speakers per request: `speaker_0` in one clip is not
 * necessarily `speaker_0` in the next. This keeps voice numbers (1, 2, ...) for
 * one meeting. Scribe offers no way to match a speaker across requests, so the
 * only continuity assumed is that a clip opens with whoever closed the last one;
 * every other speaker in a clip is a new voice. A person may therefore appear as
 * more than one voice — visible and nameable — rather than two people silently
 * merging.
 */
export class ScribeVoiceMap {
  private next = 1;
  private lastVoice: number | null = null;

  assign(runs: ScribeSpeakerRun[]): { text: string; voice: number }[] {
    const ids = new Map<string, number>();
    const out = runs.map((r) => {
      let voice = ids.get(r.speakerId);
      if (voice === undefined) {
        voice = ids.size === 0 && this.lastVoice !== null ? this.lastVoice : this.next++;
        ids.set(r.speakerId, voice);
      }
      return { text: r.text, voice };
    });
    const last = out[out.length - 1];
    if (last) this.lastVoice = last.voice;
    return out;
  }
}

export class ElevenLabsScribeBackend implements WhisperBackend {
  /** Live words come from `openLiveStream`, not from re-reading a prefix. */
  readonly supportsLivePartials = false;
  readonly costModel = SCRIBE_MODEL;
  constructor(private readonly opts: ScribeBackendOptions) {}

  async transcribe(pcm: Int16Array): Promise<string> {
    return this.transcribeClip(pcm16ToWav(pcm, SAMPLE_RATE), 'wav');
  }

  async transcribeClip(audio: Buffer, format: 'm4a' | 'wav'): Promise<string> {
    const apiKey = readKey(this.opts.apiKey);
    if (apiKey === undefined) {
      throw new ScribeError('ELEVEN_LABS_API_KEY is no longer set on this host');
    }
    const form = new FormData();
    form.append('model_id', SCRIBE_MODEL);
    form.append('language_code', 'en');
    // Scribe tags non-speech by default ("[coughs]", "[phone ringing]"), and a
    // clip of only background noise came back as that tag and was sent as a turn.
    form.append('tag_audio_events', 'false');
    form.append(
      'file',
      new Blob([new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength)], {
        type: format === 'wav' ? 'audio/wav' : 'audio/m4a',
      }),
      `clip.${format}`,
    );
    const doFetch = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(SCRIBE_URL, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey },
        body: form,
      });
    } catch (err) {
      throw new ScribeError(`ElevenLabs transcription request failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ScribeError(
        `ElevenLabs transcription failed: HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
      );
    }
    const json = (await res.json()) as { text?: unknown };
    if (typeof json.text !== 'string') {
      throw new ScribeError('ElevenLabs transcription returned no transcript');
    }
    return json.text.trim();
  }

  /**
   * Transcribes a clip with speaker diarisation and audio-event tagging.
   * Speaker ids are Scribe's own, per request (see `ScribeVoiceMap`).
   */
  async transcribeDiarised(wav: Buffer): Promise<ScribeSpeakerRun[]> {
    const apiKey = readKey(this.opts.apiKey);
    if (apiKey === undefined) {
      throw new ScribeError('ELEVEN_LABS_API_KEY is no longer set on this host');
    }
    const form = new FormData();
    form.append('model_id', SCRIBE_MODEL);
    form.append('language_code', 'en');
    form.append('diarize', 'true');
    form.append('tag_audio_events', 'true');
    form.append(
      'file',
      new Blob([new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength)], { type: 'audio/wav' }),
      'clip.wav',
    );
    const doFetch = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(SCRIBE_URL, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey },
        body: form,
      });
    } catch (err) {
      throw new ScribeError(`ElevenLabs transcription request failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ScribeError(
        `ElevenLabs transcription failed: HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
      );
    }
    const json = (await res.json()) as { words?: unknown };
    if (!Array.isArray(json.words)) {
      throw new ScribeError('ElevenLabs transcription returned no words');
    }
    return scribeSpeakerRuns(json.words as ScribeWord[]);
  }

  openLiveStream(
    onText: (text: string) => void,
    onError: (message: string) => void,
  ): ScribeRealtimeStream {
    const stream = new ScribeRealtimeStream(
      {
        apiKey: this.opts.apiKey,
        logger: this.opts.logger,
        ...(this.opts.wsCtor ? { wsCtor: this.opts.wsCtor } : {}),
        ...(this.opts.wsUrl ? { wsUrl: this.opts.wsUrl } : {}),
      },
      { onText, onError },
    );
    stream.start();
    return stream;
  }

  async close(): Promise<void> {}
}
