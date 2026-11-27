// Direct calls (spec/07 § Direct calls; spec/05 § Speech engines).
//
// A direct call has no voice agent: the device turns speech into text, sends it
// to the chat as the user's turn, and reads the chat agent's reply aloud. Every
// app surface reports which speech engines it can run for one — on-device
// engines it has installed, cloud engines the account has a key for — and each
// device has its own setup (`deviceDirectCall`, by surface id). A cloud engine
// is reached through the chat's host, which holds the key; the device never
// holds one.
//
// NO FALLBACK: a setup naming an engine the device does not report is refused,
// naming it; nothing is answered by another engine.

import { z } from 'zod';

/** Speech to text engines: on the device (Parakeet in the desktop app, Android's recogniser) or in the cloud. */
export const DirectSttEngine = z.enum(['parakeet', 'android', 'groq', 'elevenlabs']);
export type DirectSttEngine = z.infer<typeof DirectSttEngine>;

/** Text to speech engines: on the device (Kokoro on a computer that has it, Android's voices) or in the cloud. */
export const DirectTtsEngine = z.enum(['kokoro', 'android', 'elevenlabs', 'openai']);
export type DirectTtsEngine = z.infer<typeof DirectTtsEngine>;

export const SpeechEngineWhere = z.enum(['device', 'cloud']);
export type SpeechEngineWhere = z.infer<typeof SpeechEngineWhere>;

/** The cloud engines, each reached through the chat's host. */
export const CLOUD_STT_ENGINES = [
  'groq',
  'elevenlabs',
] as const satisfies readonly DirectSttEngine[];
export const CLOUD_TTS_ENGINES = [
  'elevenlabs',
  'openai',
] as const satisfies readonly DirectTtsEngine[];
export type CloudSttEngine = (typeof CLOUD_STT_ENGINES)[number];
export type CloudTtsEngine = (typeof CLOUD_TTS_ENGINES)[number];

export const STT_ENGINE_LABEL: Record<DirectSttEngine, string> = {
  parakeet: 'Parakeet',
  android: 'Android',
  groq: 'Groq Whisper',
  elevenlabs: 'ElevenLabs Scribe',
};
export const TTS_ENGINE_LABEL: Record<DirectTtsEngine, string> = {
  kokoro: 'Kokoro',
  android: 'Android',
  elevenlabs: 'ElevenLabs',
  openai: 'OpenAI',
};

/**
 * One engine a surface reports. Not strict, and the engine id is a plain
 * string: a surface newer than the server must not have its whole report
 * refused over an engine this build has not heard of.
 */
const ReportedStt = z.object({
  engine: z.string().min(1),
  where: SpeechEngineWhere,
  models: z.array(z.string().min(1)),
});
const ReportedTts = ReportedStt.extend({ voices: z.array(z.string().min(1)) });
export type ReportedSttEngine = z.infer<typeof ReportedStt>;
export type ReportedTtsEngine = z.infer<typeof ReportedTts>;

/** `surface.speech_engines` body: what this surface can run for a direct call. */
export const SpeechEngineReport = z.object({
  stt: z.array(ReportedStt),
  tts: z.array(ReportedTts),
});
export type SpeechEngineReport = z.infer<typeof SpeechEngineReport>;

/**
 * Cloud models offered before Settings has read the provider's own list. A
 * cloud engine's models come from its API (spec/14 § Voice); these are the
 * ones the host can call without that read.
 */
export const CLOUD_STT_MODELS: Record<CloudSttEngine, readonly string[]> = {
  groq: ['whisper-large-v3-turbo', 'whisper-large-v3'],
  elevenlabs: ['scribe_v2'],
};
export const CLOUD_TTS_MODELS: Record<CloudTtsEngine, readonly string[]> = {
  elevenlabs: ['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2', 'eleven_v3'],
  openai: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
};
export const OPENAI_TTS_VOICES: readonly string[] = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
];

/**
 * The cloud engines the account can use, from the keys its hosts report
 * (`host.host.providerKeys` ids with a value): Groq and ElevenLabs Scribe read
 * speech; ElevenLabs and OpenAI speak. ElevenLabs voices are the account's own
 * list, as a host reports it.
 */
export function cloudSpeechEngines(
  keys: ReadonlySet<string>,
  elevenLabsVoices: readonly string[],
): SpeechEngineReport {
  const stt: ReportedSttEngine[] = [];
  const tts: ReportedTtsEngine[] = [];
  if (keys.has('groq'))
    stt.push({ engine: 'groq', where: 'cloud', models: [...CLOUD_STT_MODELS.groq] });
  if (keys.has('elevenlabs')) {
    stt.push({ engine: 'elevenlabs', where: 'cloud', models: [...CLOUD_STT_MODELS.elevenlabs] });
    tts.push({
      engine: 'elevenlabs',
      where: 'cloud',
      models: [...CLOUD_TTS_MODELS.elevenlabs],
      voices: [...elevenLabsVoices],
    });
  }
  if (keys.has('openai')) {
    tts.push({
      engine: 'openai',
      where: 'cloud',
      models: [...CLOUD_TTS_MODELS.openai],
      voices: [...OPENAI_TTS_VOICES],
    });
  }
  return { stt, tts };
}

/** How the reply sounds: only the chosen engine's own controls apply (spec/07 § Direct calls). */
export const DirectTtsSound = z
  .object({
    /** ElevenLabs, OpenAI: raw text, into the engine's instructions as written. */
    tone: z.string().max(2000).optional(),
    /** ElevenLabs, 0..1. */
    stability: z.number().min(0).max(1).optional(),
    similarity: z.number().min(0).max(1).optional(),
    style: z.number().min(0).max(1).optional(),
    /** ElevenLabs 0.7..1.2, OpenAI 0.25..4, Kokoro 0.5..2. */
    speed: z.number().min(0.25).max(4).optional(),
  })
  .strict();
export type DirectTtsSound = z.infer<typeof DirectTtsSound>;

/** Which sound controls each engine takes. */
export const TTS_SOUND_CONTROLS: Record<DirectTtsEngine, readonly (keyof DirectTtsSound)[]> = {
  elevenlabs: ['tone', 'stability', 'similarity', 'style', 'speed'],
  openai: ['tone', 'speed'],
  kokoro: ['speed'],
  android: [],
};

/** One device's direct-call setup (`deviceDirectCall[surfaceId]`). */
export const DirectCallSetup = z
  .object({
    stt: z.object({ engine: DirectSttEngine, model: z.string().min(1).optional() }).strict(),
    tts: z
      .object({
        engine: DirectTtsEngine,
        model: z.string().min(1).optional(),
        voice: z.string().min(1).optional(),
        sound: DirectTtsSound.optional(),
      })
      .strict(),
  })
  .strict();
export type DirectCallSetup = z.infer<typeof DirectCallSetup>;

/** The setup a direct call runs on, every part resolved. */
export interface ResolvedDirectCall {
  stt: { engine: DirectSttEngine; where: SpeechEngineWhere; model: string };
  tts: {
    engine: DirectTtsEngine;
    where: SpeechEngineWhere;
    model: string;
    voice: string | undefined;
    sound: DirectTtsSound;
  };
}

export const NO_SPEECH_ENGINE = 'No speech engine';

export type DirectCallResolution =
  | { ok: true; call: ResolvedDirectCall }
  | { ok: false; reason: string };

function knownStt(e: ReportedSttEngine): e is ReportedSttEngine & { engine: DirectSttEngine } {
  return (DirectSttEngine.options as readonly string[]).includes(e.engine);
}
function knownTts(e: ReportedTtsEngine): e is ReportedTtsEngine & { engine: DirectTtsEngine } {
  return (DirectTtsEngine.options as readonly string[]).includes(e.engine);
}

/** On-device engines first: free, and no network trip. */
function preferDevice<T extends { where: SpeechEngineWhere }>(xs: T[]): T[] {
  return [...xs.filter((x) => x.where === 'device'), ...xs.filter((x) => x.where === 'cloud')];
}

/** The one-line summary Settings and the call bar show (`Parakeet → Kokoro`). */
export function directCallSummary(call: Pick<ResolvedDirectCall, 'stt' | 'tts'>): string {
  return `${STT_ENGINE_LABEL[call.stt.engine]} → ${TTS_ENGINE_LABEL[call.tts.engine]}`;
}

/**
 * What a direct call from this device runs on. A device that reports no speech
 * to text or no text to speech engine has `No speech engine`. A device with no
 * setup chosen yet runs on the first engine it reports for each step, on-device
 * ones first, with that engine's first model and voice. A setup naming an engine
 * the device does not report is refused with what to change — never swapped.
 */
export function resolveDirectCall(
  report: SpeechEngineReport,
  setup: DirectCallSetup | undefined,
): DirectCallResolution {
  const stts = preferDevice(report.stt.filter(knownStt));
  const ttss = preferDevice(report.tts.filter(knownTts));
  if (stts.length === 0 || ttss.length === 0) return { ok: false, reason: NO_SPEECH_ENGINE };
  const fix = 'Pick another in Settings → Voice calls → Direct calls.';

  const stt = setup ? stts.find((e) => e.engine === setup.stt.engine) : stts[0];
  if (!stt) {
    return {
      ok: false,
      reason: `This device's speech to text is set to ${STT_ENGINE_LABEL[setup!.stt.engine]}, which it does not have. ${fix}`,
    };
  }
  const tts = setup ? ttss.find((e) => e.engine === setup.tts.engine) : ttss[0];
  if (!tts) {
    return {
      ok: false,
      reason: `This device's text to speech is set to ${TTS_ENGINE_LABEL[setup!.tts.engine]}, which it does not have. ${fix}`,
    };
  }
  const sttModel = setup?.stt.model ?? stt.models[0];
  if (sttModel === undefined) {
    return { ok: false, reason: `${STT_ENGINE_LABEL[stt.engine]} reports no model. ${fix}` };
  }
  const ttsModel = setup?.tts.model ?? tts.models[0];
  if (ttsModel === undefined) {
    return { ok: false, reason: `${TTS_ENGINE_LABEL[tts.engine]} reports no model. ${fix}` };
  }
  const voice = setup?.tts.voice ?? tts.voices[0];
  if (voice === undefined && tts.engine !== 'android') {
    return {
      ok: false,
      reason: `${TTS_ENGINE_LABEL[tts.engine]} has no voice to speak with. ${fix}`,
    };
  }
  const allowed = new Set(TTS_SOUND_CONTROLS[tts.engine]);
  const sound: DirectTtsSound = {};
  for (const [k, v] of Object.entries(setup?.tts.sound ?? {})) {
    if (allowed.has(k as keyof DirectTtsSound)) (sound as Record<string, unknown>)[k] = v;
  }
  return {
    ok: true,
    call: {
      stt: { engine: stt.engine, where: stt.where, model: sttModel },
      tts: { engine: tts.engine, where: tts.where, model: ttsModel, voice, sound },
    },
  };
}

/** Bar label while the chat agent works: `Agent working · 0:42`. */
export function agentWorkingLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `Agent working · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Cut a reply into the pieces read aloud one after another, so the first
 * sentence plays while the next is being made. Markdown that reads badly
 * aloud (code fences, link targets, emphasis marks, headings) is dropped.
 */
export function speakablePieces(markdown: string): string[] {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+(.*?)[.:]?\s*$/gm, '$1.')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return [];
  const sentences = text.split(/(?<=[.!?]["')\]]*)\s+/);
  const pieces: string[] = [];
  let cur = '';
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    // Join very short sentences so each request carries enough to sound natural.
    if (cur && (cur.length < 40 || s.length < 12) && cur.length + s.length < 300)
      cur = `${cur} ${s}`;
    else {
      if (cur) pieces.push(cur);
      cur = s;
    }
  }
  if (cur) pieces.push(cur);
  return pieces;
}

/** What a host reports that says which cloud engines the account can use. */
export interface HostSpeechKeys {
  providerKeys?: readonly { id: string; source: 'ui' | 'env' | 'none' }[] | undefined;
  elevenLabsVoices?: readonly { id: string }[] | undefined;
}

/**
 * The cloud engines from every host's report. Keys are the account's, set once
 * in Settings → Keys and held by every host, so any host holding one counts.
 */
export function cloudSpeechEnginesFromHosts(hosts: readonly HostSpeechKeys[]): SpeechEngineReport {
  const keys = new Set<string>();
  const voices: string[] = [];
  for (const h of hosts) {
    for (const k of h.providerKeys ?? []) if (k.source !== 'none') keys.add(k.id);
    for (const v of h.elevenLabsVoices ?? []) if (!voices.includes(v.id)) voices.push(v.id);
  }
  return cloudSpeechEngines(keys, voices);
}

/** A device's on-device engines and the account's cloud engines, as one report. */
export function mergeSpeechEngines(
  device: SpeechEngineReport,
  cloud: SpeechEngineReport,
): SpeechEngineReport {
  return { stt: [...device.stt, ...cloud.stt], tts: [...device.tts, ...cloud.tts] };
}
