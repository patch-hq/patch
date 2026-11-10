// Hosted speech-to-text for meetings (spec/07): Deepgram Nova-3 and AssemblyAI
// Universal, one diarised request per meeting clip. Each returns the clip as runs
// by speaker, the same shape ElevenLabs Scribe does, so one `ScribeVoiceMap` turns
// any of them into the meeting's numbered voices.
//
// NO SILENT FALLBACK: a missing key or a failed request throws and fails the clip;
// it is never answered by quietly transcribing locally instead.

import type { Logger } from 'pino';
import { readKey, type KeySource } from './keySource.js';
import type { ScribeSpeakerRun } from './elevenlabs-stt.js';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class MeetingSttError extends Error {
  override readonly name = 'MeetingSttError';
}

/** What every hosted meeting engine offers. */
export interface DiarisedClipEngine {
  /** Model name for the voice ledger. */
  readonly costModel: string;
  transcribeDiarised(wav: Buffer): Promise<ScribeSpeakerRun[]>;
}

export interface MeetingSttOptions {
  logger: Logger;
  /** Resolved per request (keySource.ts), so a changed key applies to the next clip. */
  apiKey: KeySource;
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: FetchLike;
}

function bytes(b: Buffer): Uint8Array {
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

async function failure(what: string, res: Response): Promise<MeetingSttError> {
  const body = await res.text().catch(() => '');
  return new MeetingSttError(
    `${what} failed: HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
  );
}

/** Consecutive stretches by the same speaker are one run; empty ones go. */
function mergeRuns(runs: ScribeSpeakerRun[]): ScribeSpeakerRun[] {
  const out: ScribeSpeakerRun[] = [];
  for (const r of runs) {
    const text = r.text.trim();
    if (text === '') continue;
    const last = out[out.length - 1];
    if (last && last.speakerId === r.speakerId) last.text += ` ${text}`;
    else out.push({ speakerId: r.speakerId, text });
  }
  return out;
}

export const DEEPGRAM_MEETING_MODEL = 'nova-3';
const DEEPGRAM_LISTEN_URL = 'https://api.deepgram.com/v1/listen';

export class DeepgramMeetingBackend implements DiarisedClipEngine {
  readonly costModel = DEEPGRAM_MEETING_MODEL;
  constructor(private readonly opts: MeetingSttOptions) {}

  async transcribeDiarised(wav: Buffer): Promise<ScribeSpeakerRun[]> {
    const apiKey = readKey(this.opts.apiKey);
    if (apiKey === undefined) {
      throw new MeetingSttError('The Deepgram key is no longer set on this host');
    }
    const url = `${DEEPGRAM_LISTEN_URL}?${new URLSearchParams({
      model: DEEPGRAM_MEETING_MODEL,
      language: 'en',
      smart_format: 'true',
      diarize: 'true',
      utterances: 'true',
    }).toString()}`;
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(url, {
        method: 'POST',
        headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/wav' },
        body: bytes(wav),
      });
    } catch (err) {
      throw new MeetingSttError(`Deepgram transcription request failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw await failure('Deepgram transcription', res);
    const json = (await res.json()) as {
      results?: { utterances?: Array<{ speaker?: unknown; transcript?: unknown }> };
    };
    const utterances = json.results?.utterances;
    if (!Array.isArray(utterances)) {
      throw new MeetingSttError('Deepgram transcription returned no utterances');
    }
    return mergeRuns(
      utterances.map((u) => {
        if (typeof u.transcript !== 'string' || typeof u.speaker !== 'number') {
          throw new MeetingSttError('Deepgram returned an utterance with no text or speaker');
        }
        return { speakerId: String(u.speaker), text: u.transcript };
      }),
    );
  }
}

export const ASSEMBLYAI_MEETING_MODEL = 'universal';
const ASSEMBLYAI_API = 'https://api.assemblyai.com/v2';

export interface AssemblyAiOptions extends MeetingSttOptions {
  /** Test seam — defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** How long one clip may take before it fails. */
  timeoutMs?: number;
}

export class AssemblyAiMeetingBackend implements DiarisedClipEngine {
  readonly costModel = ASSEMBLYAI_MEETING_MODEL;
  constructor(private readonly opts: AssemblyAiOptions) {}

  private async call(path: string, init: RequestInit, what: string): Promise<unknown> {
    const apiKey = readKey(this.opts.apiKey);
    if (apiKey === undefined) {
      throw new MeetingSttError('The AssemblyAI key is no longer set on this host');
    }
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(`${ASSEMBLYAI_API}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: apiKey },
      });
    } catch (err) {
      throw new MeetingSttError(`AssemblyAI ${what} request failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw await failure(`AssemblyAI ${what}`, res);
    return res.json();
  }

  async transcribeDiarised(wav: Buffer): Promise<ScribeSpeakerRun[]> {
    const up = (await this.call(
      '/upload',
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes(wav) },
      'upload',
    )) as { upload_url?: unknown };
    if (typeof up.upload_url !== 'string') {
      throw new MeetingSttError('AssemblyAI upload returned no upload_url');
    }
    const created = (await this.call(
      '/transcript',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio_url: up.upload_url,
          speaker_labels: true,
          speech_model: ASSEMBLYAI_MEETING_MODEL,
          language_code: 'en',
        }),
      },
      'transcription',
    )) as { id?: unknown };
    if (typeof created.id !== 'string') {
      throw new MeetingSttError('AssemblyAI transcription returned no id');
    }
    const sleep = this.opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    const pollMs = this.opts.pollMs ?? 1000;
    const deadline = Date.now() + (this.opts.timeoutMs ?? 120_000);
    for (;;) {
      const t = (await this.call(`/transcript/${created.id}`, { method: 'GET' }, 'poll')) as {
        status?: unknown;
        error?: unknown;
        utterances?: Array<{ speaker?: unknown; text?: unknown }> | null;
      };
      if (t.status === 'error') {
        throw new MeetingSttError(
          `AssemblyAI transcription failed: ${typeof t.error === 'string' ? t.error : 'unknown error'}`,
        );
      }
      if (t.status === 'completed') {
        // A clip with no speech completes with no utterances: that is silence, not an error.
        return mergeRuns(
          (t.utterances ?? []).map((u) => {
            if (typeof u.text !== 'string' || typeof u.speaker !== 'string') {
              throw new MeetingSttError('AssemblyAI returned an utterance with no text or speaker');
            }
            return { speakerId: u.speaker, text: u.text };
          }),
        );
      }
      if (Date.now() >= deadline) {
        throw new MeetingSttError('AssemblyAI transcription timed out');
      }
      await sleep(pollMs);
    }
  }
}
