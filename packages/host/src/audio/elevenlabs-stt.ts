// ElevenLabs Scribe as a speech-to-text engine (spec/07 § Dictation engines).
//
// Two shapes, both on the same key (`ELEVEN_LABS_API_KEY`):
//   - ElevenLabsScribeBackend — a WhisperBackend. One request per clip
//     (`POST /v1/speech-to-text`, scribe_v2). Selected for the local voice tier
//     with WHISPER_BACKEND=elevenlabs, and used to read a voice-note clip when
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
  private readonly pending: string[] = [];
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
      onError: (message: string) => void;
    },
  ) {}

  /** Audio seconds sent so far — what the provider bills. */
  get audioSeconds(): number {
    return this.samples / SAMPLE_RATE;
  }

  get isOpen(): boolean {
    return this.open;
  }

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
      for (const m of this.pending.splice(0)) ws.send(m);
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
    const audio = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    this.send({
      message_type: 'input_audio_chunk',
      audio_base_64: audio,
      commit: false,
      sample_rate: SAMPLE_RATE,
    });
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
    if (this.open) this.ws!.send(raw);
    else this.pending.push(raw);
  }

  private emit(): void {
    if (this.closed || this.failed) return;
    const text = this.text();
    if (text === this.lastText) return;
    this.lastText = text;
    this.handlers.onText(text);
  }

  private fail(message: string): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.commitWaiter?.();
    this.openWaiter?.();
    this.deps.logger.error({ err: message }, 'scribe-realtime');
    this.handlers.onError(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
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
