// ElevenLabs text-to-speech, a speech-out backend alongside Kokoro.
//
// It fills the same seam Kokoro does (`KokoroBackend`): `synthesize(text, voice)`
// returns PCM16 mono @ 24 kHz as an async iterator, so the voice session, the
// house speakers and everything else that speaks need not know which engine is
// behind it. Audio is requested as `pcm_24000` from the streaming endpoint and
// handed on as it arrives.
//
// NO FALLBACK: no key, no voice, a refused request (bad key, quota spent) or a
// stream that dies part-way all throw, with the provider's own words. Nothing
// here ever reaches for Kokoro or another provider instead.

import type { Logger } from 'pino';
import { readKey, type KeySource } from './keySource.js';
import type { KokoroBackend, KokoroChunk, KokoroSynthesis, SynthOptions } from './kokoro.js';
import { speechCostUsd, type SpeechUsage } from './voiceCost.js';

export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';
/** Low-latency model: conversation turns, where the first audio matters. */
export const ELEVENLABS_LIVE_MODEL = 'eleven_flash_v2_5';
/** Higher-quality model: announcements and briefings, spoken once. */
export const ELEVENLABS_ANNOUNCE_MODEL = 'eleven_multilingual_v2';

/** Voice Design model: turns a description into candidate voices. */
export const ELEVENLABS_DESIGN_MODEL = 'eleven_ttv_v3';

/** One candidate voice from Voice Design, with a sample of it speaking. */
export interface DesignedVoicePreview {
  generatedVoiceId: string;
  /** mp3 sample, base64. */
  audioBase64: string;
  durationSecs?: number;
  text?: string;
}

/** A voice on the account, cloned and designed ones included. */
export interface ElevenLabsVoice {
  id: string;
  name: string;
  category?: string;
}

export interface CreateElevenLabsOptions {
  apiKey: KeySource;
  logger: Logger;
  /** Called once per accepted request, with what it will bill. */
  onUsage?: (usage: SpeechUsage) => void;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
}

export class ElevenLabsError extends Error {
  override readonly name = 'ElevenLabsError';
}

/** The provider's own explanation of a refusal, or the bare status. */
async function failureText(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  let detail = body.slice(0, 300);
  try {
    const j = JSON.parse(body) as { detail?: { message?: string; status?: string } | string };
    if (typeof j.detail === 'string') detail = j.detail;
    else if (j.detail?.message) detail = `${j.detail.status ?? ''} ${j.detail.message}`.trim();
  } catch {
    // Not JSON: the raw text above stands.
  }
  return `HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
}

const missingKey = (): ElevenLabsError =>
  new ElevenLabsError(
    'ElevenLabs is selected for speech but this host has no ELEVEN_LABS_API_KEY. Set it in Settings → Hosts → Keys.',
  );

export class ElevenLabsBackend implements KokoroBackend {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => number;

  constructor(private readonly opts: CreateElevenLabsOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? ELEVENLABS_BASE_URL;
    this.now = opts.now ?? Date.now;
  }

  isReady(): boolean {
    return readKey(this.opts.apiKey) !== undefined;
  }

  async close(): Promise<void> {}

  /** Every voice on the account. Throws with the provider's reason on failure. */
  async listVoices(): Promise<ElevenLabsVoice[]> {
    const key = readKey(this.opts.apiKey);
    if (key === undefined) throw missingKey();
    const res = await this.fetchImpl(`${this.baseUrl}/v1/voices`, {
      headers: { 'xi-api-key': key },
    });
    if (!res.ok) {
      throw new ElevenLabsError(`ElevenLabs voice list failed: ${await failureText(res)}`);
    }
    const body = (await res.json()) as {
      voices?: { voice_id: string; name: string; category?: string }[];
    };
    if (!Array.isArray(body.voices)) {
      throw new ElevenLabsError('ElevenLabs voice list failed: response had no voices');
    }
    return body.voices.map((v) => ({
      id: v.voice_id,
      name: v.name,
      ...(v.category ? { category: v.category } : {}),
    }));
  }

  /**
   * Voice Design: ElevenLabs invents candidate voices from a written
   * description. Each preview is a short sample; nothing is kept on the
   * account until `saveDesignedVoice`. Spends credits, so it is recorded.
   */
  async designVoicePreviews(description: string): Promise<DesignedVoicePreview[]> {
    const key = readKey(this.opts.apiKey);
    if (key === undefined) throw missingKey();
    const res = await this.fetchImpl(`${this.baseUrl}/v1/text-to-voice/design`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        voice_description: description,
        model_id: ELEVENLABS_DESIGN_MODEL,
        auto_generate_text: true,
      }),
    });
    if (!res.ok)
      throw new ElevenLabsError(`ElevenLabs voice design failed: ${await failureText(res)}`);
    const body = (await res.json()) as {
      previews?: { generated_voice_id: string; audio_base_64: string; duration_secs?: number }[];
      text?: string;
    };
    if (!Array.isArray(body.previews) || body.previews.length === 0) {
      throw new ElevenLabsError('ElevenLabs voice design failed: response had no previews');
    }
    this.opts.onUsage?.({
      kind: 'tts',
      provider: 'elevenlabs',
      model: ELEVENLABS_DESIGN_MODEL,
      characters: (body.text ?? '').length,
      at: this.now(),
      usd: speechCostUsd(ELEVENLABS_DESIGN_MODEL, (body.text ?? '').length),
    });
    return body.previews.map((p) => ({
      generatedVoiceId: p.generated_voice_id,
      audioBase64: p.audio_base_64,
      ...(p.duration_secs !== undefined ? { durationSecs: p.duration_secs } : {}),
      ...(body.text !== undefined ? { text: body.text } : {}),
    }));
  }

  /** Keep a previewed voice on the account; returns the id the voice picker lists. */
  async saveDesignedVoice(args: {
    name: string;
    description: string;
    generatedVoiceId: string;
  }): Promise<ElevenLabsVoice> {
    const key = readKey(this.opts.apiKey);
    if (key === undefined) throw missingKey();
    const res = await this.fetchImpl(`${this.baseUrl}/v1/text-to-voice`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        voice_name: args.name,
        voice_description: args.description,
        generated_voice_id: args.generatedVoiceId,
      }),
    });
    if (!res.ok)
      throw new ElevenLabsError(`ElevenLabs voice save failed: ${await failureText(res)}`);
    const body = (await res.json()) as { voice_id?: string };
    if (typeof body.voice_id !== 'string') {
      throw new ElevenLabsError('ElevenLabs voice save failed: response had no voice_id');
    }
    return { id: body.voice_id, name: args.name, category: 'generated' };
  }

  async synthesize(text: string, voice?: string, opts?: SynthOptions): Promise<KokoroSynthesis> {
    const key = readKey(this.opts.apiKey);
    if (key === undefined) throw missingKey();
    if (voice === undefined || voice === '') {
      throw new ElevenLabsError(
        'ElevenLabs is selected for speech but no voice is chosen. Pick one in Settings → Voice.',
      );
    }
    const model = opts?.purpose === 'announce' ? ELEVENLABS_ANNOUNCE_MODEL : ELEVENLABS_LIVE_MODEL;
    const abort = new AbortController();
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=pcm_24000`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({ text, model_id: model }),
          signal: abort.signal,
        },
      );
    } catch (err) {
      throw new ElevenLabsError(`ElevenLabs request failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new ElevenLabsError(`ElevenLabs refused speech: ${await failureText(res)}`);
    if (res.body === null) throw new ElevenLabsError('ElevenLabs returned no audio stream');

    this.opts.onUsage?.({
      kind: 'tts',
      provider: 'elevenlabs',
      model,
      characters: text.length,
      at: this.now(),
      usd: speechCostUsd(model, text.length),
    });
    this.opts.logger.info({ model, characters: text.length }, 'elevenlabs: synthesis started');

    const reader = res.body.getReader();
    let cancelled = false;
    async function* chunks(): AsyncIterableIterator<KokoroChunk> {
      let first = true;
      // A network chunk can end mid-sample; the odd byte waits for the next.
      let carry: number | undefined;
      let sawAudio = false;
      for (;;) {
        let read: Awaited<ReturnType<typeof reader.read>>;
        try {
          read = await reader.read();
        } catch (err) {
          if (cancelled) return;
          throw new ElevenLabsError(`ElevenLabs stream failed: ${(err as Error).message}`);
        }
        if (read.done) break;
        let bytes = read.value;
        if (carry !== undefined && bytes.length > 0) {
          const joined = new Uint8Array(bytes.length + 1);
          joined[0] = carry;
          joined.set(bytes, 1);
          bytes = joined;
          carry = undefined;
        }
        if (bytes.length % 2 === 1) {
          carry = bytes[bytes.length - 1];
          bytes = bytes.subarray(0, bytes.length - 1);
        }
        if (bytes.length === 0) continue;
        const pcm = new Int16Array(bytes.length / 2);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
        for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true);
        sawAudio = true;
        yield { pcm, first };
        first = false;
      }
      if (!sawAudio && !cancelled) {
        throw new ElevenLabsError('ElevenLabs returned an empty audio stream');
      }
    }
    return {
      iterator: chunks(),
      cancel: async () => {
        cancelled = true;
        abort.abort();
        await reader.cancel().catch(() => undefined);
      },
    };
  }
}

export function createElevenLabs(opts: CreateElevenLabsOptions): ElevenLabsBackend {
  return new ElevenLabsBackend(opts);
}

/**
 * Speech-out as the session sees it: Kokoro or ElevenLabs, chosen in Settings
 * and read on every utterance so a change applies to the next one. The choice
 * is exclusive: the unchosen engine is never consulted, and a failure in the
 * chosen one is not routed to the other.
 */
export type TtsChoice = 'kokoro' | 'elevenlabs';

export function createRoutedTts(deps: {
  kokoro: KokoroBackend;
  elevenlabs: KokoroBackend;
  choice: () => TtsChoice;
}): KokoroBackend {
  const active = (): KokoroBackend =>
    deps.choice() === 'elevenlabs' ? deps.elevenlabs : deps.kokoro;
  return {
    synthesize: (text, voice, opts) => active().synthesize(text, voice, opts),
    isReady: () => active().isReady(),
    close: async () => {
      await Promise.all([deps.kokoro.close(), deps.elevenlabs.close()]);
    },
  };
}
