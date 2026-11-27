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
import {
  SoundValues,
  soundProblem,
  soundValues,
  toneFor,
  type VoiceEngine,
  type VoiceTones,
} from './voiceEngines.js';

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

const ReportedStt = z
  .object({
    engine: DirectSttEngine,
    where: SpeechEngineWhere,
    models: z.array(z.string().min(1)),
  })
  .strict();
const ReportedTts = z
  .object({
    engine: DirectTtsEngine,
    where: SpeechEngineWhere,
    models: z.array(z.string().min(1)),
    voices: z.array(z.string().min(1)),
  })
  .strict();
export type ReportedSttEngine = z.infer<typeof ReportedStt>;
export type ReportedTtsEngine = z.infer<typeof ReportedTts>;

/** `surface.speech_engines` body: what this surface can run for a direct call. */
export const SpeechEngineReport = z
  .object({
    stt: z.array(ReportedStt),
    tts: z.array(ReportedTts),
  })
  .strict();
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

/**
 * How the reply sounds, resolved for a call: the engine's controls (stored or
 * default) and the voice's tone. What a host's cloud speech is sent.
 */
export const DirectTtsSound = z
  .object({
    /** ElevenLabs, OpenAI: raw text, into the engine's instructions as written. */
    tone: z.string().max(2000).optional(),
    stability: z.number().min(0).max(1).optional(),
    similarity: z.number().min(0).max(1).optional(),
    style: z.number().min(0).max(1).optional(),
    speed: z.number().min(0.25).max(4).optional(),
  })
  .strict();
export type DirectTtsSound = z.infer<typeof DirectTtsSound>;

const tone = { kind: 'tone', key: 'tone', label: 'Tone' } as const;
const slower = { low: 'Slower', high: 'Faster', suffix: '×' } as const;

/**
 * Each text to speech engine's "how it sounds" controls (spec/07 § Direct
 * calls), in the same form as the voice agent's (voiceEngines.ts), so one
 * renderer draws both. Tone is kept per voice (`voiceTones`).
 */
export const DIRECT_TTS_ENGINES: Record<DirectTtsEngine, VoiceEngine> = {
  elevenlabs: {
    id: 'elevenlabs',
    label: TTS_ENGINE_LABEL.elevenlabs,
    controls: [
      tone,
      {
        kind: 'slider',
        key: 'stability',
        label: 'Stability',
        default: 0.7,
        min: 0,
        max: 1,
        step: 0.05,
        low: 'Expressive',
        high: 'Steady',
      },
      {
        kind: 'slider',
        key: 'similarity',
        label: 'Similarity',
        default: 0.8,
        min: 0,
        max: 1,
        step: 0.05,
      },
      { kind: 'slider', key: 'style', label: 'Style', default: 0, min: 0, max: 1, step: 0.05 },
      {
        kind: 'slider',
        key: 'speed',
        label: 'Speed',
        default: 0.95,
        min: 0.7,
        max: 1.2,
        step: 0.05,
        ...slower,
      },
    ],
  },
  openai: {
    id: 'openai',
    label: TTS_ENGINE_LABEL.openai,
    controls: [
      tone,
      {
        kind: 'slider',
        key: 'speed',
        label: 'Speed',
        default: 1,
        min: 0.25,
        max: 4,
        step: 0.05,
        ...slower,
      },
    ],
  },
  kokoro: {
    id: 'kokoro',
    label: TTS_ENGINE_LABEL.kokoro,
    controls: [
      {
        kind: 'slider',
        key: 'speed',
        label: 'Speed',
        default: 1,
        min: 0.5,
        max: 2,
        step: 0.05,
        ...slower,
      },
    ],
  },
  android: { id: 'android', label: TTS_ENGINE_LABEL.android, controls: [] },
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
        /** The engine's own controls (`DIRECT_TTS_ENGINES`); tone is per voice, in `voiceTones`. */
        sound: SoundValues.optional(),
      })
      .strict()
      .superRefine((tts, ctx) => {
        const problem = soundProblem(DIRECT_TTS_ENGINES[tts.engine], tts.sound ?? {});
        if (problem) ctx.addIssue({ code: 'custom', path: ['sound'], message: problem });
      }),
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
  tones: VoiceTones,
): DirectCallResolution {
  const stts = preferDevice(report.stt);
  const ttss = preferDevice(report.tts);
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
  // The engine's controls, stored or default, and the voice's tone. A stored
  // sound belongs to the engine it was set for: another engine starts on its own.
  const stored = setup?.tts.engine === tts.engine ? (setup.tts.sound ?? {}) : {};
  const toneText = toneFor(tones, tts.engine, voice);
  const sound = {
    ...soundValues(DIRECT_TTS_ENGINES[tts.engine], stored),
    ...(toneText !== undefined ? { tone: toneText } : {}),
  } as DirectTtsSound;
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

export interface SpeechEngineReporter {
  /** Send the report now, changed or not (a fresh connection). */
  report(): void;
  /** Send it if it has changed (a host gained a key, a model was downloaded). */
  refresh(): void;
  stop(): void;
}

/**
 * Reports a surface's speech engines to the server (spec/05 § Speech engines):
 * on every connect, and whenever they change. The same on every surface; each
 * supplies how to read its engines, how to send, and when its hosts change.
 */
export function createSpeechEngineReporter(deps: {
  read: () => Promise<SpeechEngineReport>;
  send: (e: { type: 'surface.speech_engines' } & SpeechEngineReport) => void;
  onHostsChange: (cb: () => void) => () => void;
  onError: (e: unknown) => void;
}): SpeechEngineReporter {
  let last: string | null = null;
  let stopped = false;
  const run = (force: boolean): void => {
    deps.read().then((r) => {
      const key = JSON.stringify(r);
      if (stopped || (!force && key === last)) return;
      last = key;
      deps.send({ type: 'surface.speech_engines', stt: r.stt, tts: r.tts });
    }, deps.onError);
  };
  const unsub = deps.onHostsChange(() => run(false));
  return {
    report: () => run(true),
    refresh: () => run(false),
    stop: () => {
      stopped = true;
      unsub();
    },
  };
}

// --- Settings → Voice calls → Direct calls (spec/14 § Voice) ---------------

/** A choice Settings offers: an engine, labelled with where it runs. */
export interface DirectEngineOption<E extends string> {
  engine: E;
  label: string;
  where: SpeechEngineWhere;
}

/** Each step of a device's setup: what it offers and what is chosen now. */
export interface DirectCallSteps {
  stt: { options: DirectEngineOption<DirectSttEngine>[]; engine: DirectSttEngine | undefined };
  sttModel: { options: string[]; value: string | undefined };
  tts: { options: DirectEngineOption<DirectTtsEngine>[]; engine: DirectTtsEngine | undefined };
  ttsModel: { options: string[]; value: string | undefined };
  voice: { options: string[]; value: string | undefined };
  /** The stored sound of the chosen engine (defaults are the description's). */
  sound: SoundValues;
  /** One line for the row: `Parakeet → Kokoro`, `No speech engine`, or why the setup cannot run. */
  summary: string;
  /** Why the stored setup cannot run here, or undefined. */
  problem: string | undefined;
}

/**
 * What Settings shows for one device. Only the engines the device reported are
 * offered; a choice it no longer reports stays shown, with the reason.
 */
export function directCallSteps(
  report: SpeechEngineReport,
  setup: DirectCallSetup | undefined,
  tones: VoiceTones,
): DirectCallSteps {
  const resolved = resolveDirectCall(report, setup, tones);
  const call = resolved.ok ? resolved.call : undefined;
  const sttEngine = setup?.stt.engine ?? call?.stt.engine;
  const ttsEngine = setup?.tts.engine ?? call?.tts.engine;
  const stt = report.stt.find((e) => e.engine === sttEngine);
  const tts = report.tts.find((e) => e.engine === ttsEngine);
  return {
    stt: {
      options: preferDevice(report.stt).map((e) => ({
        engine: e.engine,
        label: STT_ENGINE_LABEL[e.engine],
        where: e.where,
      })),
      engine: sttEngine,
    },
    sttModel: { options: stt?.models ?? [], value: setup?.stt.model ?? call?.stt.model },
    tts: {
      options: preferDevice(report.tts).map((e) => ({
        engine: e.engine,
        label: TTS_ENGINE_LABEL[e.engine],
        where: e.where,
      })),
      engine: ttsEngine,
    },
    ttsModel: { options: tts?.models ?? [], value: setup?.tts.model ?? call?.tts.model },
    voice: { options: tts?.voices ?? [], value: setup?.tts.voice ?? call?.tts.voice },
    sound: setup?.tts.sound ?? {},
    summary: call
      ? directCallSummary(call)
      : resolved.ok
        ? ''
        : resolved.reason === NO_SPEECH_ENGINE
          ? NO_SPEECH_ENGINE
          : 'Needs setting up',
    problem: !resolved.ok && resolved.reason !== NO_SPEECH_ENGINE ? resolved.reason : undefined,
  };
}

export type DirectCallChange =
  | { step: 'stt'; engine: DirectSttEngine }
  | { step: 'sttModel'; model: string }
  | { step: 'tts'; engine: DirectTtsEngine }
  | { step: 'ttsModel'; model: string }
  | { step: 'voice'; voice: string }
  | { step: 'sound'; sound: SoundValues };

/**
 * The setup one change in Settings makes. Everything after a changed engine
 * starts over (its model, voice and sound belong to the engine), so the next
 * step is chosen again rather than carried across.
 */
export function changeDirectCall(
  steps: DirectCallSteps,
  change: DirectCallChange,
): DirectCallSetup {
  const stt = {
    engine: steps.stt.engine!,
    ...(steps.sttModel.value ? { model: steps.sttModel.value } : {}),
  };
  const tts = {
    engine: steps.tts.engine!,
    ...(steps.ttsModel.value ? { model: steps.ttsModel.value } : {}),
    ...(steps.voice.value ? { voice: steps.voice.value } : {}),
    ...(Object.keys(steps.sound).length > 0 ? { sound: steps.sound } : {}),
  };
  switch (change.step) {
    case 'stt':
      return { stt: { engine: change.engine }, tts };
    case 'sttModel':
      return { stt: { ...stt, model: change.model }, tts };
    case 'tts':
      return { stt, tts: { engine: change.engine } };
    case 'ttsModel':
      return { stt, tts: { ...tts, model: change.model } };
    case 'voice':
      return { stt, tts: { ...tts, voice: change.voice } };
    case 'sound':
      return { stt, tts: { ...tts, sound: change.sound } };
  }
}

const KOKORO_ACCENT: Record<string, string> = {
  af: 'American F',
  am: 'American M',
  bf: 'British F',
  bm: 'British M',
};

/**
 * A Kokoro voice as people read it, from Kokoro's own id convention
 * (`af_heart` → `Heart (American F)`). An id outside the convention is shown
 * as it is.
 */
export function kokoroVoiceLabel(id: string): string {
  const m = /^([ab][fm])_(\w+)$/.exec(id);
  if (!m) return id;
  return `${m[2]!.charAt(0).toUpperCase()}${m[2]!.slice(1)} (${KOKORO_ACCENT[m[1]!]})`;
}

/** The voices the host's Kokoro speaks in (`kokoroVoice`), for a voice device answering directly. */
export const HOST_KOKORO_VOICES: readonly string[] = [
  'af_heart',
  'af_bella',
  'af_sky',
  'af_sarah',
  'af_nicole',
  'am_adam',
  'am_michael',
  'bf_emma',
  'bf_isabella',
  'bm_george',
  'bm_lewis',
];
