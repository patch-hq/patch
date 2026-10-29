// Hosted speech-to-text for dictation (spec/07 § Dictation engines): Deepgram,
// one request per clip (`POST /v1/listen`, nova-3). This is only the CLIP path —
// a voice note, a dictation-mode utterance, a composer upload. A live dictation
// on deepgram streams instead (deepgram-dictation.ts) and its live words are
// the transcript.
//
// It implements `WhisperBackend`, so the pipeline that reads a clip need not
// know which engine it is talking to; the choice is made once, by
// `pickDictationTranscriber` below.
//
// NO SILENT FALLBACK: deepgram with no key on this host is refused
// (`voice_key_missing`) and a failed request throws; it is never answered by
// quietly transcribing with Whisper instead.

import type { Logger } from 'pino';
import { voiceKeyMissingMessage, type DictationEngine } from '@patch/wire/audio';
import { pcm16ToWav, type WhisperBackend } from './whisper.js';
import { readKey, type KeySource } from './keySource.js';

export const DEEPGRAM_MODEL = 'nova-3';
const DEEPGRAM_LISTEN_URL = 'https://api.deepgram.com/v1/listen';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Thrown for a failed hosted transcription; carries the provider so callers can map the error code. */
export class HostedSttError extends Error {
  override readonly name = 'HostedSttError';
  constructor(
    readonly backend: 'deepgram',
    message: string,
  ) {
    super(message);
  }
}

interface HostedSttBase {
  logger: Logger;
  /** Resolved per request (keySource.ts), so a changed key applies to the next clip. */
  apiKey: KeySource;
  model?: string;
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: FetchLike;
}

function mimeFor(format: 'm4a' | 'wav'): string {
  return format === 'wav' ? 'audio/wav' : 'audio/m4a';
}

async function failureText(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  return `HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`;
}

export class DeepgramTranscribeBackend implements WhisperBackend {
  readonly supportsLivePartials = false;
  private readonly opts: HostedSttBase;
  constructor(opts: HostedSttBase) {
    this.opts = opts;
  }

  async transcribe(pcm: Int16Array): Promise<string> {
    return this.transcribeClip(pcm16ToWav(pcm, 16000), 'wav');
  }

  async transcribeClip(audio: Buffer, format: 'm4a' | 'wav'): Promise<string> {
    const apiKey = readKey(this.opts.apiKey);
    if (apiKey === undefined) {
      throw new HostedSttError(
        'deepgram',
        'The Deepgram key is no longer set on this host; add it in Settings → Providers',
      );
    }
    const url = `${DEEPGRAM_LISTEN_URL}?${new URLSearchParams({
      model: this.opts.model ?? DEEPGRAM_MODEL,
      language: 'en',
      smart_format: 'true',
    }).toString()}`;
    const doFetch = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { Authorization: `Token ${apiKey}`, 'Content-Type': mimeFor(format) },
        body: new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength),
      });
    } catch (err) {
      throw new HostedSttError(
        'deepgram',
        `Deepgram transcription request failed: ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new HostedSttError(
        'deepgram',
        `Deepgram transcription failed: ${await failureText(res)}`,
      );
    }
    const json = (await res.json()) as {
      results?: { channels?: Array<{ alternatives?: Array<{ transcript?: unknown }> }> };
    };
    const transcript = json.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    if (typeof transcript !== 'string') {
      throw new HostedSttError('deepgram', 'Deepgram transcription returned no transcript');
    }
    return transcript.trim();
  }

  async close(): Promise<void> {}
}

export interface DictationTranscribers {
  /** The host's Whisper (`WHISPER_BACKEND`). */
  local: WhisperBackend;
  /** Present only while this host holds a Deepgram key. */
  deepgram?: WhisperBackend | undefined;
}

/**
 * What reads a clip for a dictation on `engine`, or an error naming exactly why
 * it can't run (the Deepgram key isn't on this host). A clip from a phone on its
 * own recogniser — a voice note, a dictation-mode utterance — is read by
 * Whisper: that recogniser is on the phone, and a clip is on the host.
 */
export function pickDictationTranscriber(
  engine: DictationEngine,
  transcribers: DictationTranscribers,
): { ok: true; whisper: WhisperBackend } | { ok: false; backend: 'deepgram'; message: string } {
  if (engine !== 'deepgram') return { ok: true, whisper: transcribers.local };
  const t = transcribers.deepgram;
  if (t) return { ok: true, whisper: t };
  return {
    ok: false,
    backend: 'deepgram',
    message: voiceKeyMissingMessage('dictation', 'deepgram'),
  };
}

/**
 * The transcribers, Deepgram offered only while this host HAS its key — a
 * getter over a live key source, so a key set or revoked from Settings changes
 * what the next dictation picks with no rebuild.
 */
export function createDictationTranscribers(opts: {
  logger: Logger;
  local: WhisperBackend;
  deepgramApiKey?: KeySource;
}): DictationTranscribers {
  const deepgram = new DeepgramTranscribeBackend({
    logger: opts.logger,
    apiKey: opts.deepgramApiKey,
  });
  return {
    local: opts.local,
    get deepgram(): WhisperBackend | undefined {
      return readKey(opts.deepgramApiKey) !== undefined ? deepgram : undefined;
    },
  };
}
