// A direct call's cloud speech (spec/07 § Direct calls). The call runs on the
// device, but a cloud engine's key lives on the chat's host, so the device sends
// one utterance to be read, or one piece of the reply to be spoken, through the
// server to here. Each request names its engine and model and runs on exactly
// that; a failure names the engine and is never answered by another.

import type { Logger } from 'pino';
import type { DirectTtsSound } from '@patch/wire/direct-call';
import type {
  PatchVoiceDirectSpeakRequestEvent,
  PatchVoiceDirectTranscribeRequestEvent,
  WireEvent,
} from '@patch/wire';

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const ELEVENLABS_URL = 'https://api.elevenlabs.io';
const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
const DEFAULT_GROQ_MODEL = 'whisper-large-v3-turbo';
const DEFAULT_SCRIBE_MODEL = 'scribe_v2';

export interface DirectSpeechDeps {
  /** The key this host holds for a provider right now, read per request. */
  key: (provider: 'groq' | 'elevenlabs' | 'openai') => string | undefined;
  fetchImpl?: typeof fetch;
  logger: Pick<Logger, 'warn'>;
}

type ErrorCode = 'key_missing' | 'engine_failed' | 'internal';

class DirectSpeechError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const KEY_NAME = { groq: 'Groq', elevenlabs: 'ElevenLabs', openai: 'OpenAI' } as const;

function needKey(deps: DirectSpeechDeps, provider: 'groq' | 'elevenlabs' | 'openai'): string {
  const k = deps.key(provider);
  if (k === undefined || k === '') {
    throw new DirectSpeechError(
      'key_missing',
      `no ${KEY_NAME[provider]} key is set on this host (add it in Settings → Keys)`,
    );
  }
  return k;
}

/** Messages leave out the engine's name: the surface already names the engine it asked. */
async function failure(res: Response): Promise<DirectSpeechError> {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    detail = '';
  }
  return new DirectSpeechError(
    'engine_failed',
    `HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
  );
}

/** Read one utterance (16 kHz mono WAV) with the chosen cloud engine. */
export async function directTranscribe(
  req: Pick<PatchVoiceDirectTranscribeRequestEvent, 'engine' | 'model' | 'audioBase64'>,
  deps: DirectSpeechDeps,
): Promise<string> {
  const f = deps.fetchImpl ?? fetch;
  const wav = new Blob([Buffer.from(req.audioBase64, 'base64')], { type: 'audio/wav' });
  const form = new FormData();
  form.append('file', wav, 'utterance.wav');
  if (req.engine === 'groq') {
    const key = needKey(deps, 'groq');
    form.append('model', req.model ?? DEFAULT_GROQ_MODEL);
    form.append('language', 'en');
    form.append('temperature', '0');
    form.append('response_format', 'json');
    const res = await f(GROQ_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) throw await failure(res);
    const body = (await res.json()) as { text?: unknown };
    if (typeof body.text !== 'string') {
      throw new DirectSpeechError('engine_failed', 'the answer had no text');
    }
    return body.text.trim();
  }
  const key = needKey(deps, 'elevenlabs');
  form.append('model_id', req.model ?? DEFAULT_SCRIBE_MODEL);
  const res = await f(`${ELEVENLABS_URL}/v1/speech-to-text`, {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
  });
  if (!res.ok) throw await failure(res);
  const body = (await res.json()) as { text?: unknown };
  if (typeof body.text !== 'string') {
    throw new DirectSpeechError('engine_failed', 'the answer had no text');
  }
  return body.text.trim();
}

/** The `[tags]` in a tone, which an ElevenLabs v3 model takes as audio tags. */
export function audioTags(tone: string | undefined): string {
  return (tone?.match(/\[[^\]\n]{1,40}\]/g) ?? []).join(' ');
}

/** ElevenLabs' own voice settings from the device's sound controls; absent ones are left to the voice. */
export function elevenLabsVoiceSettings(sound: DirectTtsSound): Record<string, number> {
  const out: Record<string, number> = {};
  if (sound.stability !== undefined) out['stability'] = sound.stability;
  if (sound.similarity !== undefined) out['similarity_boost'] = sound.similarity;
  if (sound.style !== undefined) out['style'] = sound.style;
  if (sound.speed !== undefined) out['speed'] = sound.speed;
  return out;
}

/** Speak one piece of a reply with the chosen cloud engine: 24 kHz mono PCM16. */
export async function directSpeak(
  req: Pick<PatchVoiceDirectSpeakRequestEvent, 'engine' | 'model' | 'voice' | 'sound' | 'text'>,
  deps: DirectSpeechDeps,
): Promise<Buffer> {
  const f = deps.fetchImpl ?? fetch;
  if (req.engine === 'elevenlabs') {
    const key = needKey(deps, 'elevenlabs');
    const tags = req.model.startsWith('eleven_v3') ? audioTags(req.sound.tone) : '';
    const settings = elevenLabsVoiceSettings(req.sound);
    const res = await f(
      `${ELEVENLABS_URL}/v1/text-to-speech/${encodeURIComponent(req.voice)}?output_format=pcm_24000`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          text: tags ? `${tags} ${req.text}` : req.text,
          model_id: req.model,
          ...(Object.keys(settings).length > 0 ? { voice_settings: settings } : {}),
        }),
      },
    );
    if (!res.ok) throw await failure(res);
    return Buffer.from(await res.arrayBuffer());
  }
  const key = needKey(deps, 'openai');
  const res = await f(OPENAI_SPEECH_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: req.model,
      voice: req.voice,
      input: req.text,
      response_format: 'pcm',
      ...(req.sound.speed !== undefined ? { speed: req.sound.speed } : {}),
      // Only the gpt-4o TTS models take instructions; tone is sent as written.
      ...(req.sound.tone && !req.model.startsWith('tts-') ? { instructions: req.sound.tone } : {}),
    }),
  });
  if (!res.ok) throw await failure(res);
  return Buffer.from(await res.arrayBuffer());
}

function errorOf(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof DirectSpeechError) return { code: err.code, message: err.message };
  return { code: 'internal', message: (err as Error).message };
}

/** Answer a `patch.voice.direct_transcribe_request`; every failure is answered with its reason. */
export async function handleDirectTranscribe(
  event: PatchVoiceDirectTranscribeRequestEvent,
  deps: DirectSpeechDeps,
  sender: (e: WireEvent) => void,
): Promise<void> {
  try {
    const transcript = await directTranscribe(event, deps);
    sender({
      type: 'patch.voice.direct_transcribe_response',
      requestId: event.requestId,
      ok: true,
      transcript,
    });
  } catch (err) {
    const error = errorOf(err);
    deps.logger.warn({ ...error, engine: event.engine }, 'direct call: transcription failed');
    sender({
      type: 'patch.voice.direct_transcribe_response',
      requestId: event.requestId,
      ok: false,
      error,
    });
  }
}

/** Answer a `patch.voice.direct_speak_request`; every failure is answered with its reason. */
export async function handleDirectSpeak(
  event: PatchVoiceDirectSpeakRequestEvent,
  deps: DirectSpeechDeps,
  sender: (e: WireEvent) => void,
): Promise<void> {
  try {
    const pcm = await directSpeak(event, deps);
    if (pcm.byteLength === 0) {
      throw new DirectSpeechError('engine_failed', 'it returned no audio');
    }
    sender({
      type: 'patch.voice.direct_speak_response',
      requestId: event.requestId,
      ok: true,
      pcmBase64: pcm.toString('base64'),
    });
  } catch (err) {
    const error = errorOf(err);
    deps.logger.warn({ ...error, engine: event.engine }, 'direct call: speech failed');
    sender({
      type: 'patch.voice.direct_speak_response',
      requestId: event.requestId,
      ok: false,
      error,
    });
  }
}
