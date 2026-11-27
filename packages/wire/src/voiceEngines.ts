// What each voice engine offers, described once (spec/07 § The voice agent,
// § Direct calls). A description lists the engine's "how it sounds" controls,
// in Settings order, each with its kind, its bounds and default, and the field
// of the provider's own config it sets. That one description drives Settings
// on web, desktop and the phone (a generic renderer per surface) and the
// host's provider config (`soundConfig`), so no surface or session carries a
// branch per provider for what a control is or does.

import { z } from 'zod';

export type SoundValue = number | boolean | string;

interface ControlBase {
  key: string;
  label: string;
  /**
   * Where the value goes in the provider's config, as a dotted path from the
   * root the engine's session merges sound into. Absent: the value is not
   * sent as a field (tone goes into the instructions).
   */
  field?: string;
}

/**
 * Tone: raw text, kept per voice (`voiceTones`), placed in the instructions as
 * written. `tags` also sends its `[tags]` as a list to `field` while the
 * control named `when` matches `pattern` (ElevenLabs' suggested audio tags on a
 * v3 speech model).
 */
export interface ToneControl extends ControlBase {
  kind: 'tone';
  tags?: { field: string; when: string; pattern: string };
}
export interface ToggleControl extends ControlBase {
  kind: 'toggle';
  default: boolean;
  /** Sent only when on: the field is not accepted everywhere the engine runs. */
  onlyWhenOn?: true;
}
export interface SliderControl extends ControlBase {
  kind: 'slider';
  default: number;
  min: number;
  max: number;
  step: number;
  /** What each end means, where the number alone does not say. */
  low?: string;
  high?: string;
  /** Shown after the value: `0.95×`. */
  suffix?: string;
}
export interface ChoiceControl extends ControlBase {
  kind: 'choice';
  default: string;
  options: readonly { id: string; label: string }[];
}
/** A choice from a list the provider's API returns (`VoiceCatalogEntry[list]`). Absent: the provider's default. */
export interface ListControl extends ControlBase {
  kind: 'list';
  list: 'speechModels';
  placeholder: string;
}
export type SoundControl =
  | ToneControl
  | ToggleControl
  | SliderControl
  | ChoiceControl
  | ListControl;

export interface VoiceEngine {
  id: string;
  label: string;
  controls: readonly SoundControl[];
}

const tone: ToneControl = { kind: 'tone', key: 'tone', label: 'Tone' };
const slower = { low: 'Slower', high: 'Faster', suffix: '×' } as const;

export const VoiceAgentProvider = z.enum(['gemini', 'openai', 'elevenlabs']);
export type VoiceAgentProvider = z.infer<typeof VoiceAgentProvider>;

/**
 * The voice agent engines. Field paths are each provider's own, checked
 * against its API reference on 2026-11-27: Gemini Live's `setup`
 * (`generationConfig.enableAffectiveDialog`, v1alpha only), OpenAI Realtime's
 * `session` (`audio.output.speed`, 0.25–1.5), ElevenLabs Agents'
 * `conversation_config` (`tts.*`, `turn.turn_eagerness`).
 */
export const VOICE_AGENT_ENGINES: Record<VoiceAgentProvider, VoiceEngine> = {
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    controls: [
      tone,
      {
        kind: 'toggle',
        key: 'matchTone',
        label: 'Match my tone',
        default: false,
        onlyWhenOn: true,
        field: 'generationConfig.enableAffectiveDialog',
      },
    ],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    controls: [
      tone,
      {
        kind: 'slider',
        key: 'speed',
        label: 'Speed',
        default: 1,
        min: 0.25,
        max: 1.5,
        step: 0.05,
        ...slower,
        field: 'audio.output.speed',
      },
    ],
  },
  elevenlabs: {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    controls: [
      {
        kind: 'list',
        key: 'speechModel',
        label: 'Speech model',
        list: 'speechModels',
        placeholder: 'ElevenLabs default',
        field: 'tts.model_id',
      },
      {
        ...tone,
        tags: { field: 'tts.suggested_audio_tags', when: 'speechModel', pattern: '(^|_)v3(_|$)' },
      },
      {
        kind: 'toggle',
        key: 'expressiveMode',
        label: 'Expressive mode',
        default: true,
        field: 'tts.expressive_mode',
      },
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
        field: 'tts.stability',
      },
      {
        kind: 'slider',
        key: 'similarity',
        label: 'Similarity',
        default: 0.8,
        min: 0,
        max: 1,
        step: 0.05,
        field: 'tts.similarity_boost',
      },
      {
        kind: 'slider',
        key: 'speed',
        label: 'Speed',
        default: 0.95,
        min: 0.7,
        max: 1.2,
        step: 0.05,
        ...slower,
        field: 'tts.speed',
      },
      {
        kind: 'choice',
        key: 'eagerness',
        label: 'Reply eagerness',
        default: 'patient',
        options: [
          { id: 'patient', label: 'Patient' },
          { id: 'normal', label: 'Normal' },
          { id: 'eager', label: 'Eager' },
        ],
        field: 'turn.turn_eagerness',
      },
    ],
  },
};

export const VOICE_AGENT_PROVIDER_LABEL: Record<VoiceAgentProvider, string> = {
  gemini: VOICE_AGENT_ENGINES.gemini.label,
  openai: VOICE_AGENT_ENGINES.openai.label,
  elevenlabs: VOICE_AGENT_ENGINES.elevenlabs.label,
};

/** The stored values of an engine's controls; tone is kept per voice, not here. */
export const SoundValues = z.record(z.string(), z.union([z.number(), z.boolean(), z.string()]));
export type SoundValues = z.infer<typeof SoundValues>;

/** Why `values` do not fit `engine`'s controls, or null. */
export function soundProblem(engine: VoiceEngine, values: SoundValues): string | null {
  for (const [key, value] of Object.entries(values)) {
    const c = engine.controls.find((x) => x.key === key);
    if (!c || c.kind === 'tone') return `${engine.label} has no sound control "${key}"`;
    const bad = `${engine.label} ${c.label}: ${JSON.stringify(value)} is not allowed`;
    if (c.kind === 'toggle' && typeof value !== 'boolean') return bad;
    if (c.kind === 'slider' && (typeof value !== 'number' || value < c.min || value > c.max)) {
      return `${bad} (${c.min}–${c.max})`;
    }
    if (c.kind === 'choice' && !c.options.some((o) => o.id === value)) return bad;
    if (c.kind === 'list' && (typeof value !== 'string' || value === '')) return bad;
  }
  return null;
}

/** Every control's value: the stored one, else its default. A list control with none is absent. */
export function soundValues(engine: VoiceEngine, stored: SoundValues): SoundValues {
  const out: SoundValues = {};
  for (const c of engine.controls) {
    const v = stored[c.key];
    if (v !== undefined) out[c.key] = v;
    else if (c.kind === 'toggle' || c.kind === 'slider' || c.kind === 'choice')
      out[c.key] = c.default;
  }
  return out;
}

/** The `[tags]` written in a tone, each once, in the order written. */
export function audioTagsFromTone(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[([^\][]+)\]/g)) {
    const tag = m[1]!.trim();
    if (tag !== '' && !out.includes(tag)) out.push(tag);
  }
  return out;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let at = target;
  for (const p of parts.slice(0, -1)) {
    const next = at[p];
    if (typeof next !== 'object' || next === null) at[p] = {};
    at = at[p] as Record<string, unknown>;
  }
  at[parts[parts.length - 1]!] = value;
}

/**
 * The provider config a sound sets: each control's value at its field, the
 * tone's tags where its engine takes them. The engine's session merges this
 * into its own config root (`mergeConfig`).
 */
export function soundConfig(
  engine: VoiceEngine,
  stored: SoundValues,
  toneText: string | undefined,
): Record<string, unknown> {
  const values = soundValues(engine, stored);
  const out: Record<string, unknown> = {};
  for (const c of engine.controls) {
    if (c.kind === 'tone') {
      if (!c.tags || toneText === undefined) continue;
      const gate = values[c.tags.when];
      if (typeof gate !== 'string' || !new RegExp(c.tags.pattern).test(gate)) continue;
      const tags = audioTagsFromTone(toneText);
      if (tags.length > 0)
        setPath(
          out,
          c.tags.field,
          tags.map((tag) => ({ tag })),
        );
      continue;
    }
    const v = values[c.key];
    if (v === undefined || c.field === undefined) continue;
    if (c.kind === 'toggle' && c.onlyWhenOn && v !== true) continue;
    setPath(out, c.field, v);
  }
  return out;
}

/** `extra` merged into `base`, objects merged key by key; `extra` wins. */
export function mergeConfig<T extends object>(base: T, extra: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(extra)) {
    const b = out[k];
    out[k] =
      typeof b === 'object' &&
      b !== null &&
      !Array.isArray(b) &&
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v)
        ? mergeConfig(b as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out as T;
}

// --- the account's voice agent setup ---------------------------------------

/** One engine's choices: model and voice from the provider's lists, and its sound. */
export const EngineSetup = z
  .object({
    model: z.string().min(1).optional(),
    voice: z.string().min(1).optional(),
    sound: SoundValues,
  })
  .strict();
export type EngineSetup = z.infer<typeof EngineSetup>;

/**
 * The account's one voice agent setup: the provider, and each provider's own
 * setup, so switching provider and back finds it as it was.
 */
export const VoiceAgentSetting = z
  .object({
    provider: VoiceAgentProvider,
    setups: z
      .object({ gemini: EngineSetup, openai: EngineSetup, elevenlabs: EngineSetup })
      .strict(),
  })
  .strict()
  .superRefine((agent, ctx) => {
    for (const p of VoiceAgentProvider.options) {
      const problem = soundProblem(VOICE_AGENT_ENGINES[p], agent.setups[p].sound);
      if (problem) ctx.addIssue({ code: 'custom', path: ['setups', p, 'sound'], message: problem });
    }
  });
export type VoiceAgentSetting = z.infer<typeof VoiceAgentSetting>;

/**
 * The out-of-the-box setup: each provider's documented realtime model at the
 * time of writing, so a first call works with nothing chosen. Sound is each
 * control's default (calm: see the descriptions above).
 */
export const DEFAULT_VOICE_AGENT: VoiceAgentSetting = {
  provider: 'gemini',
  setups: {
    gemini: { model: 'models/gemini-2.5-flash-native-audio-preview-12-2025', sound: {} },
    openai: { model: 'gpt-realtime-2.1-mini', voice: 'marin', sound: {} },
    elevenlabs: { model: 'claude-haiku-4-5', sound: {} },
  },
};

/** Tone texts by voice, `<engine>:<voice id>` → raw text (`voiceTones`). */
export const VoiceTones = z.record(z.string().min(1), z.string().max(2000));
export type VoiceTones = z.infer<typeof VoiceTones>;

/** Where a voice's tone is kept: tone is per voice. */
export function voiceToneKey(engine: string, voice: string): string {
  return `${engine}:${voice}`;
}

/** A voice's tone, or undefined when it has none worth sending. */
export function toneFor(
  tones: VoiceTones,
  engine: string,
  voice: string | undefined,
): string | undefined {
  if (voice === undefined) return undefined;
  const text = tones[voiceToneKey(engine, voice)];
  return text !== undefined && text.trim() !== '' ? text : undefined;
}
