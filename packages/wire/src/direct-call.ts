// Direct calls (spec/07 § Direct calls; spec/05 § Speech engines).
//
// A direct call has no voice agent: the device turns speech into text, sends it
// to the chat as the user's turn, and reads the chat agent's reply aloud. Every
// app surface reports which speech engines it can run for one — on-device
// engines it has installed, cloud engines the account has a key for — and the
// account has one setup for every device (`directCall`). A cloud engine
// is reached through the chat's host, which holds the key; the device never
// holds one.
//
// NO FALLBACK: a setup naming an engine the device does not report is refused,
// naming it; nothing is answered by another engine.

import { z } from 'zod';
import { voiceCatalogView, type CatalogHost, type CatalogProvider } from './audio.js';
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

/**
 * `listProblem`: a cloud engine whose models (and voices) could not be read
 * from its provider says why — the read failed, or no host has read it yet —
 * and its lists are empty. Never a list built in instead.
 */
const ReportedStt = z
  .object({
    engine: DirectSttEngine,
    where: SpeechEngineWhere,
    models: z.array(z.string().min(1)),
    listProblem: z.string().min(1).optional(),
  })
  .strict();
const ReportedTts = z
  .object({
    engine: DirectTtsEngine,
    where: SpeechEngineWhere,
    models: z.array(z.string().min(1)),
    voices: z.array(z.string().min(1)),
    listProblem: z.string().min(1).optional(),
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

/** Which provider's read lists each cloud engine's models (spec/07 § Direct calls). */
const STT_PROVIDER: Record<CloudSttEngine, CatalogProvider> = {
  groq: 'groq',
  elevenlabs: 'elevenlabs',
};
const TTS_PROVIDER: Record<CloudTtsEngine, CatalogProvider> = {
  elevenlabs: 'elevenlabs',
  openai: 'openai',
};

/** The provider whose list a step's engine offers, or null for an on-device engine. */
export function listProviderOf(
  step: 'stt' | 'tts',
  engine: DirectSttEngine | DirectTtsEngine,
): CatalogProvider | null {
  const table: Record<string, CatalogProvider> = step === 'stt' ? STT_PROVIDER : TTS_PROVIDER;
  return table[engine] ?? null;
}

/** What a host reports that says which cloud engines the account can use, and their lists. */
export interface HostSpeechKeys extends CatalogHost {
  providerKeys?: readonly { id: string; source: 'ui' | 'env' | 'none' }[] | undefined;
}

/**
 * The cloud engines the account can use, from every host's report. Keys are
 * the account's, set once in Settings → Keys and held by every host, so any
 * host holding one counts. Models and voices come from the provider's own
 * lists as a host read them (`voiceCatalog`, the same read the voice agent's
 * Settings use): ElevenLabs' and OpenAI's speech models, ElevenLabs' voices,
 * OpenAI's documented speech voices, Groq's and Scribe's transcription models.
 * A list that has not been read, or whose read failed, is empty and says why.
 */
export function cloudSpeechEnginesFromHosts(hosts: readonly HostSpeechKeys[]): SpeechEngineReport {
  const keys = new Set<string>();
  for (const h of hosts)
    for (const k of h.providerKeys ?? []) if (k.source !== 'none') keys.add(k.id);
  const read = (provider: CatalogProvider) => {
    const view = voiceCatalogView(provider, hosts);
    if (view.state === 'ready') return { entry: view.entry };
    return {
      entry: undefined,
      listProblem:
        view.state === 'failed'
          ? `the model list could not be read (${view.message})`
          : 'the model list has not been read yet',
    };
  };
  const ids = (items: readonly { id: string }[] | undefined): string[] =>
    (items ?? []).map((i) => i.id);
  const stt: ReportedSttEngine[] = [];
  const tts: ReportedTtsEngine[] = [];
  for (const engine of CLOUD_STT_ENGINES) {
    if (!keys.has(engine)) continue;
    const r = read(STT_PROVIDER[engine]);
    stt.push({
      engine,
      where: 'cloud',
      models: ids(r.entry?.transcriptionModels),
      ...(r.listProblem ? { listProblem: r.listProblem } : {}),
    });
  }
  for (const engine of CLOUD_TTS_ENGINES) {
    if (!keys.has(engine)) continue;
    const r = read(TTS_PROVIDER[engine]);
    tts.push({
      engine,
      where: 'cloud',
      models: ids(r.entry?.speechModels),
      voices: ids(engine === 'openai' ? r.entry?.speechVoices : r.entry?.voices),
      ...(r.listProblem ? { listProblem: r.listProblem } : {}),
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

/**
 * What each step of a direct call runs on: `device` is whichever engine the
 * calling device has of its own (Parakeet or Android's recogniser; Kokoro or
 * Android's voices), with its own model and voice; the rest are cloud
 * engines, the same on every device.
 */
export const DirectSttChoice = z.enum(['device', ...CLOUD_STT_ENGINES]);
export type DirectSttChoice = z.infer<typeof DirectSttChoice>;
export const DirectTtsChoice = z.enum(['device', ...CLOUD_TTS_ENGINES]);
export type DirectTtsChoice = z.infer<typeof DirectTtsChoice>;

export const ON_DEVICE_LABEL = 'On device';
const sttChoiceLabel = (c: DirectSttChoice): string =>
  c === 'device' ? ON_DEVICE_LABEL : STT_ENGINE_LABEL[c];
const ttsChoiceLabel = (c: DirectTtsChoice): string =>
  c === 'device' ? ON_DEVICE_LABEL : TTS_ENGINE_LABEL[c];

/**
 * The account's one direct-call setup (`directCall`), used by every device. A
 * cloud step carries its model (and voice); an on-device step carries none,
 * since each device runs its own.
 */
export const DirectCallSetup = z
  .object({
    stt: z.object({ engine: DirectSttChoice, model: z.string().min(1).optional() }).strict(),
    tts: z
      .object({
        engine: DirectTtsChoice,
        model: z.string().min(1).optional(),
        voice: z.string().min(1).optional(),
        /** A cloud engine's own controls (`DIRECT_TTS_ENGINES`); tone is per voice, in `voiceTones`. */
        sound: SoundValues.optional(),
      })
      .strict()
      .superRefine((tts, ctx) => {
        if (tts.engine === 'device') {
          if (tts.model || tts.voice || tts.sound)
            ctx.addIssue({
              code: 'custom',
              message: 'an on-device step has no model, voice or sound',
            });
          return;
        }
        const problem = soundProblem(DIRECT_TTS_ENGINES[tts.engine], tts.sound ?? {});
        if (problem) ctx.addIssue({ code: 'custom', path: ['sound'], message: problem });
      })
      /** Absent until chosen: a setup is saved one step at a time in Settings. */
      .optional(),
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
/** The account has not picked its direct-call setup yet, or not every step. */
export const NOT_SET_UP = 'Pick what direct calls use in Settings → Voice calls → Direct calls.';

/**
 * `settings`: the fix is a choice in Settings → Voice calls → Direct calls, so
 * a call that cannot start opens it rather than only saying no.
 */
export type DirectCallResolution =
  | { ok: true; call: ResolvedDirectCall }
  | { ok: false; reason: string; settings: boolean };

/** The one-line summary Settings and the call bar show (`Parakeet → Kokoro`). */
export function directCallSummary(call: {
  stt: { engine: DirectSttEngine };
  tts: { engine: DirectTtsEngine };
}): string {
  return `${STT_ENGINE_LABEL[call.stt.engine]} → ${TTS_ENGINE_LABEL[call.tts.engine]}`;
}

/**
 * What a direct call from this device runs on: the account's setup, with an
 * on-device step on this device's own engine (its model and its voice). A
 * device that reports no engine at all has `No speech engine`. A setup not
 * picked, or a step this device cannot run, is refused with what to change and
 * `settings` set — never swapped for something else.
 */
export function resolveDirectCall(
  report: SpeechEngineReport,
  setup: DirectCallSetup | undefined,
  tones: VoiceTones,
): DirectCallResolution {
  const no = (reason: string) => ({ ok: false as const, reason, settings: true });
  if (report.stt.length === 0 || report.tts.length === 0) {
    return { ok: false, reason: NO_SPEECH_ENGINE, settings: false };
  }
  if (setup === undefined || setup.tts === undefined) return no(NOT_SET_UP);
  const fix = 'Change it in Settings → Voice calls → Direct calls.';
  const pick = <E extends { where: SpeechEngineWhere; engine: string }>(
    xs: E[],
    choice: string,
  ): E | undefined =>
    choice === 'device'
      ? xs.find((e) => e.where === 'device')
      : xs.find((e) => e.engine === choice);
  const stt = pick(report.stt, setup.stt.engine);
  if (!stt) {
    return no(
      setup.stt.engine === 'device'
        ? `Direct calls hear you on device, and this device has no speech to text of its own. ${fix}`
        : `Direct calls hear you with ${STT_ENGINE_LABEL[setup.stt.engine]}, which has no key on any host. ${fix}`,
    );
  }
  const tts = pick(report.tts, setup.tts.engine);
  if (!tts) {
    return no(
      setup.tts.engine === 'device'
        ? `Direct calls speak on device, and this device has no voice of its own. ${fix}`
        : `Direct calls speak with ${TTS_ENGINE_LABEL[setup.tts.engine]}, which has no key on any host. ${fix}`,
    );
  }
  for (const [e, label] of [
    [stt, STT_ENGINE_LABEL[stt.engine]],
    [tts, TTS_ENGINE_LABEL[tts.engine]],
  ] as const) {
    if (e.listProblem) return no(`${label}: ${e.listProblem}.`);
  }
  // On device: the device's own model and voice. Cloud: the ones picked.
  const onDevice = (step: 'stt' | 'tts') => setup[step]!.engine === 'device';
  const sttModel = onDevice('stt') ? stt.models[0] : setup.stt.model;
  const ttsModel = onDevice('tts') ? tts.models[0] : setup.tts.model;
  const voice = onDevice('tts') ? tts.voices[0] : setup.tts.voice;
  if (sttModel === undefined || ttsModel === undefined) {
    if (onDevice(sttModel === undefined ? 'stt' : 'tts')) {
      const label =
        sttModel === undefined ? STT_ENGINE_LABEL[stt.engine] : TTS_ENGINE_LABEL[tts.engine];
      return no(`${label} on this device has no model. ${fix}`);
    }
    return no(NOT_SET_UP);
  }
  if (voice === undefined && tts.voices.length > 0) return no(NOT_SET_UP);
  for (const [model, models, label] of [
    [sttModel, stt.models, STT_ENGINE_LABEL[stt.engine]],
    [ttsModel, tts.models, TTS_ENGINE_LABEL[tts.engine]],
  ] as const) {
    if (!models.includes(model)) return no(`${label} no longer has the model ${model}. ${fix}`);
  }
  if (voice !== undefined && !tts.voices.includes(voice)) {
    return no(`${TTS_ENGINE_LABEL[tts.engine]} no longer has the voice ${voice}. ${fix}`);
  }
  if (tts.where === 'cloud' && voice === undefined) {
    return no(`${TTS_ENGINE_LABEL[tts.engine]} has no voice to speak with. ${fix}`);
  }
  const toneText = toneFor(tones, tts.engine, voice);
  const sound = {
    ...soundValues(DIRECT_TTS_ENGINES[tts.engine], onDevice('tts') ? {} : (setup.tts.sound ?? {})),
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

/** A choice Settings offers: On device, or a cloud engine. */
export interface DirectEngineOption<E extends string> {
  engine: E;
  label: string;
  where: SpeechEngineWhere;
}

/** Each step of the account's setup: what it offers and what is chosen now. */
export interface DirectCallSteps {
  stt: { options: DirectEngineOption<DirectSttChoice>[]; engine: DirectSttChoice | undefined };
  /** A cloud engine's models; empty and not asked for on device. */
  sttModel: { options: string[]; value: string | undefined };
  tts: { options: DirectEngineOption<DirectTtsChoice>[]; engine: DirectTtsChoice | undefined };
  ttsModel: { options: string[]; value: string | undefined };
  voice: { options: string[]; value: string | undefined };
  /** The stored sound of the chosen cloud engine (defaults are the description's). */
  sound: SoundValues;
  /** What this device's calls run on (`Parakeet → ElevenLabs`), or `Set up`. */
  summary: string;
  /** Why this device cannot run the setup, or undefined. */
  problem: string | undefined;
}

/**
 * What Settings shows: the account's one setup, offering On device and every
 * cloud engine the account has a key for, checked against the device Settings
 * is open on (`report`: its own engines and the account's cloud ones).
 */
export function directCallSteps(
  report: SpeechEngineReport,
  setup: DirectCallSetup | undefined,
  tones: VoiceTones,
): DirectCallSteps {
  const resolved = resolveDirectCall(report, setup, tones);
  const sttEngine = setup?.stt.engine;
  const ttsEngine = setup?.tts?.engine;
  const stt = report.stt.find((e) => e.where === 'cloud' && e.engine === sttEngine);
  const tts = report.tts.find((e) => e.where === 'cloud' && e.engine === ttsEngine);
  const device = { where: 'device' as const };
  return {
    stt: {
      options: [
        { engine: 'device', label: ON_DEVICE_LABEL, ...device },
        ...report.stt
          .filter((e) => e.where === 'cloud')
          .map((e) => ({
            engine: e.engine as DirectSttChoice,
            label: sttChoiceLabel(e.engine as DirectSttChoice),
            where: 'cloud' as const,
          })),
      ],
      engine: sttEngine,
    },
    sttModel: { options: stt?.models ?? [], value: setup?.stt.model },
    tts: {
      options: [
        { engine: 'device', label: ON_DEVICE_LABEL, ...device },
        ...report.tts
          .filter((e) => e.where === 'cloud')
          .map((e) => ({
            engine: e.engine as DirectTtsChoice,
            label: ttsChoiceLabel(e.engine as DirectTtsChoice),
            where: 'cloud' as const,
          })),
      ],
      engine: ttsEngine,
    },
    ttsModel: { options: tts?.models ?? [], value: setup?.tts?.model },
    voice: { options: tts?.voices ?? [], value: setup?.tts?.voice },
    sound: setup?.tts?.sound ?? {},
    summary: resolved.ok ? directCallSummary(resolved.call) : 'Set up',
    // A list that could not be read is shown at its step (Settings' list line), not again here.
    problem:
      !resolved.ok &&
      resolved.reason !== NOT_SET_UP &&
      stt?.listProblem === undefined &&
      tts?.listProblem === undefined
        ? resolved.reason
        : undefined,
  };
}

export type DirectCallChange =
  | { step: 'stt'; engine: DirectSttChoice }
  | { step: 'sttModel'; model: string }
  | { step: 'tts'; engine: DirectTtsChoice }
  | { step: 'ttsModel'; model: string }
  | { step: 'voice'; voice: string }
  | { step: 'sound'; sound: SoundValues };

/**
 * The setup one change in Settings makes. A changed engine's model, voice and
 * sound start over (they belong to the engine), so they are chosen again
 * rather than carried across; the other step is kept.
 */
export function changeDirectCall(
  steps: DirectCallSteps,
  change: DirectCallChange,
): DirectCallSetup {
  if (change.step === 'stt') return withTts(steps, { engine: change.engine });
  const stt = {
    engine: steps.stt.engine!,
    ...(steps.sttModel.value ? { model: steps.sttModel.value } : {}),
  };
  if (change.step === 'sttModel') return withTts(steps, { ...stt, model: change.model });
  if (change.step === 'tts') return { stt, tts: { engine: change.engine } };
  const tts = {
    engine: steps.tts.engine!,
    ...(steps.ttsModel.value ? { model: steps.ttsModel.value } : {}),
    ...(steps.voice.value ? { voice: steps.voice.value } : {}),
    ...(Object.keys(steps.sound).length > 0 ? { sound: steps.sound } : {}),
  };
  if (change.step === 'ttsModel') return { stt, tts: { ...tts, model: change.model } };
  if (change.step === 'voice') return { stt, tts: { ...tts, voice: change.voice } };
  return { stt, tts: { ...tts, sound: change.sound } };
}

/** The setup with `stt` and the text to speech already chosen, if any. */
function withTts(steps: DirectCallSteps, stt: DirectCallSetup['stt']): DirectCallSetup {
  if (steps.tts.engine === undefined) return { stt };
  return {
    stt,
    tts: {
      engine: steps.tts.engine,
      ...(steps.ttsModel.value ? { model: steps.ttsModel.value } : {}),
      ...(steps.voice.value ? { voice: steps.voice.value } : {}),
      ...(Object.keys(steps.sound).length > 0 ? { sound: steps.sound } : {}),
    },
  };
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
