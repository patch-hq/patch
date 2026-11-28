// spec/07 § Call cost — what one sustained voice session used and what it cost.
// ElevenLabs agent calls are not priced here: their real charge is read from ElevenLabs.
//
// Prices are a fixed table per model, in US dollars per million tokens, as
// published by each provider (checked 2026-10-04). A model that is not in the
// table is costed as `null` — "price unknown" — never guessed (NO FALLBACK).

import {
  directCallSummary,
  type DirectSttEngine,
  type DirectTtsEngine,
} from '@patch/wire/direct-call';
import type { DirectCallUsage } from '@patch/wire';

/** Tokens one engine used, by kind, summed over the session. */
export interface EngineTokens {
  textIn: number;
  audioIn: number;
  cachedIn: number;
  textOut: number;
  audioOut: number;
}

export const ZERO_TOKENS: EngineTokens = {
  textIn: 0,
  audioIn: 0,
  cachedIn: 0,
  textOut: 0,
  audioOut: 0,
};

export function addTokens(a: EngineTokens, b: EngineTokens): EngineTokens {
  return {
    textIn: a.textIn + b.textIn,
    audioIn: a.audioIn + b.audioIn,
    cachedIn: a.cachedIn + b.cachedIn,
    textOut: a.textOut + b.textOut,
    audioOut: a.audioOut + b.audioOut,
  };
}

interface TokenPrices {
  textIn: number;
  audioIn: number;
  cachedIn: number;
  textOut: number;
  audioOut: number;
}

/** USD per 1M tokens. Keyed by the model id with any `models/` prefix removed. */
const TOKEN_PRICES: Record<string, TokenPrices> = {
  // ai.google.dev pricing — Live API, native audio.
  'gemini-2.5-flash-native-audio-preview-12-2025': {
    textIn: 0.5,
    audioIn: 3,
    cachedIn: 0.5,
    textOut: 2,
    audioOut: 12,
  },
  'gemini-3.8-live-extended-thinking': {
    textIn: 0.75,
    audioIn: 3,
    cachedIn: 0.75,
    textOut: 4.5,
    audioOut: 12,
  },
  // developers.openai.com/api/docs/models — cached input priced at the audio
  // cached rate, the dearer of the two cached rates.
  'gpt-realtime-2.1': { textIn: 4, audioIn: 32, cachedIn: 0.4, textOut: 24, audioOut: 64 },
  'gpt-realtime-2.1-mini': {
    textIn: 0.6,
    audioIn: 10,
    cachedIn: 0.3,
    textOut: 2.4,
    audioOut: 20,
  },
};

/** Groq bills each transcription request for at least 10 s (console.groq.com/docs/speech-to-text). */
export const GROQ_MIN_BILLED_SECONDS = 10;
/** Speech to text, USD per second of billed audio (Groq: $0.04 and $0.111 an hour, checked 2026-11-28). */
const STT_USD_PER_SECOND: Record<string, number> = {
  'whisper-large-v3-turbo': 0.04 / 3600,
  'whisper-large-v3': 0.111 / 3600,
};

const modelKey = (model: string): string => model.replace(/^models\//, '');

/** Dollar cost of `tokens` on `model`, or `null` when the model's price is unknown. */
export function engineCostUsd(model: string, tokens: EngineTokens): number | null {
  const p = TOKEN_PRICES[modelKey(model)];
  if (!p) return null;
  return (
    (tokens.textIn * p.textIn +
      tokens.audioIn * p.audioIn +
      tokens.cachedIn * p.cachedIn +
      tokens.textOut * p.textOut +
      tokens.audioOut * p.audioOut) /
    1_000_000
  );
}

/** Speech-to-text use on `backend: local`. */
export interface SttUsage {
  requests: number;
  audioSeconds: number;
  billedSeconds: number;
}

/**
 * Dollar cost of `stt` on `model`, or `null` when the model is not in the table.
 * Only Groq's models are: ElevenLabs Scribe is billed in plan credits whose
 * dollar rate is not published per hour, and the meeting engines are not
 * priced here, so their usage is recorded and their cost is unknown, never guessed.
 */
export function sttCostUsd(stt: SttUsage, model: string): number | null {
  const perSecond = STT_USD_PER_SECOND[model];
  return perSecond === undefined ? null : stt.billedSeconds * perSecond;
}

/** OpenAI speech, USD per character (tts-1 $15, tts-1-hd $30 per million; checked 2026-11-28). gpt-4o-mini-tts is priced by tokens, which a character count cannot give. */
const OPENAI_TTS_USD_PER_CHAR: Record<string, number> = {
  'tts-1': 15 / 1_000_000,
  'tts-1-hd': 30 / 1_000_000,
};

/**
 * A direct call's speech (spec/07 § Call cost): what its cloud engines were
 * sent, as the device counted it. An on-device engine has no requests: it
 * costs nothing.
 */
export interface DirectCallSpeech {
  stt: {
    engine: DirectSttEngine;
    model: string;
    requests: number;
    audioSeconds: number;
    billedSeconds: number;
  };
  tts: { engine: DirectTtsEngine; model: string; requests: number; characters: number };
}

const CLOUD_ENGINES = new Set(['groq', 'elevenlabs', 'openai']);

/** The dollars of a direct call's speech; `null` when a cloud engine it used has no price here. */
export function directSpeechUsd(speech: DirectCallSpeech): number | null {
  let usd = 0;
  const { stt, tts } = speech;
  if (CLOUD_ENGINES.has(stt.engine) && stt.requests > 0) {
    const cost = sttCostUsd(
      { requests: stt.requests, audioSeconds: stt.audioSeconds, billedSeconds: stt.billedSeconds },
      stt.model,
    );
    if (cost === null) return null;
    usd += cost;
  }
  if (CLOUD_ENGINES.has(tts.engine) && tts.requests > 0) {
    const cost =
      tts.engine === 'elevenlabs'
        ? speechCostUsd(tts.model, tts.characters)
        : (() => {
            const perChar = OPENAI_TTS_USD_PER_CHAR[tts.model];
            return perChar === undefined ? null : tts.characters * perChar;
          })();
    if (cost === null) return null;
    usd += cost;
  }
  return usd;
}

/** ElevenLabs credits a direct call's speech used (text to speech on ElevenLabs only). */
export function directSpeechCredits(speech: DirectCallSpeech): number {
  if (speech.tts.engine !== 'elevenlabs') return 0;
  return speechCredits(speech.tts.model, speech.tts.characters) ?? 0;
}

/** What the session's engine reports on close. */
export interface EngineCosting {
  backend: 'local' | 'gemini' | 'openai' | 'elevenlabs';
  model: string;
  tokens: EngineTokens | null;
  stt: SttUsage | null;
  /** ElevenLabs only: seconds the agent conversation was open (what it bills by). */
  agentSeconds?: number;
  /** ElevenLabs only: the conversation id, to ask ElevenLabs what it charged. */
  conversationId?: string;
}

/** What ElevenLabs reported for a call and the plan after it. A failed lookup is `error`, never a guess. */
export type RealCharge =
  | {
      credits: number;
      /** Dollars, set only when the plan is paying by usage. */
      usd: number | null;
      creditsLeft: number | null;
      /** Why `creditsLeft` is missing. */
      leftError?: string;
    }
  | { error: string };

/** One costed session, as stored on disk and summarised into the chat. */
export interface CallCosting {
  sessionId: string;
  chatId: string;
  surfaceKind: string;
  startedAt: number;
  endedAt: number;
  backend: 'local' | 'gemini' | 'openai' | 'elevenlabs' | 'direct';
  model: string;
  tokens: EngineTokens | null;
  stt: SttUsage | null;
  agentSeconds?: number;
  conversationId?: string;
  /** `null` = the engine's price is unknown. */
  engineUsd: number | null;
  /** ElevenLabs: what the call really cost, from ElevenLabs. */
  real?: RealCharge;
  /** Requests the fast voice handed to the chat's agent; absent on records from before this was counted. */
  handoffs?: number;
  /** A direct call: its speech engines and what their cloud requests were sent. */
  direct?: DirectCallSpeech;
}

/** Cost a direct call (spec/07 § Call cost): its cloud speech, priced from the tables above. */
export function costDirectCall(args: {
  sessionId: string;
  chatId: string;
  surfaceKind: string;
  startedAt: number;
  endedAt: number;
  usage: DirectCallUsage;
}): CallCosting {
  const { stt, tts } = args.usage;
  const seconds = stt.utteranceSeconds;
  const speech: DirectCallSpeech = {
    stt: {
      engine: stt.engine,
      model: stt.model,
      requests: seconds.length,
      audioSeconds: seconds.reduce((a, b) => a + b, 0),
      // Groq bills each request for at least 10 s.
      billedSeconds: seconds.reduce(
        (a, b) => a + (stt.engine === 'groq' ? Math.max(GROQ_MIN_BILLED_SECONDS, b) : b),
        0,
      ),
    },
    tts: {
      engine: tts.engine,
      model: tts.model,
      requests: tts.requests,
      characters: tts.characters,
    },
  };
  return {
    sessionId: args.sessionId,
    chatId: args.chatId,
    surfaceKind: args.surfaceKind,
    startedAt: args.startedAt,
    endedAt: args.endedAt,
    backend: 'direct',
    model: `${speech.stt.model} → ${speech.tts.model}`,
    tokens: null,
    stt: null,
    engineUsd: directSpeechUsd(speech),
    direct: speech,
  };
}

export function costCall(args: {
  sessionId: string;
  chatId: string;
  surfaceKind: string;
  startedAt: number;
  endedAt: number;
  engine: EngineCosting;
  handoffs: number;
}): CallCosting {
  const { engine } = args;
  let engineUsd: number | null;
  if (engine.backend === 'local') {
    engineUsd = engine.stt ? sttCostUsd(engine.stt, engine.model) : 0;
  } else if (engine.backend === 'elevenlabs') {
    // Billed in plan credits: the real figure comes from ElevenLabs after the call.
    engineUsd = null;
  } else {
    engineUsd = engine.tokens ? engineCostUsd(engine.model, engine.tokens) : 0;
  }
  return {
    sessionId: args.sessionId,
    chatId: args.chatId,
    surfaceKind: args.surfaceKind,
    startedAt: args.startedAt,
    endedAt: args.endedAt,
    backend: engine.backend,
    model: engine.model,
    tokens: engine.tokens,
    stt: engine.stt,
    ...(engine.agentSeconds !== undefined ? { agentSeconds: engine.agentSeconds } : {}),
    ...(engine.conversationId !== undefined ? { conversationId: engine.conversationId } : {}),
    engineUsd,
    handoffs: args.handoffs,
  };
}

const ENGINE_NAMES: Record<string, string> = {
  scribe_v2: 'ElevenLabs Scribe',
  'gemini-2.5-flash-native-audio-preview-12-2025': 'Gemini Flash',
  'gemini-3.8-live-extended-thinking': 'Gemini Thinking',
  'gpt-realtime-2.1': 'OpenAI',
  'gpt-realtime-2.1-mini': 'OpenAI mini',
  'claude-haiku-4-5': 'ElevenLabs Haiku',
  'claude-sonnet-4-5': 'ElevenLabs Sonnet',
};

function engineName(c: CallCosting): string {
  if (c.direct) {
    return directCallSummary({
      stt: { engine: c.direct.stt.engine },
      tts: { engine: c.direct.tts.engine },
    });
  }
  if (c.backend === 'local') return c.model === 'scribe_v2' ? 'ElevenLabs Scribe' : 'Local';
  return ENGINE_NAMES[modelKey(c.model)] ?? modelKey(c.model);
}

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  // Pennies matter here: two significant figures below 10 cents.
  // `toFixed` rather than printing the number: below 1e-6 a number prints as `5e-7`.
  if (usd < 0.1) {
    const sig = Number(usd.toPrecision(2));
    const decimals = Math.min(20, Math.max(2, 1 - Math.floor(Math.log10(sig))));
    return `$${sig.toFixed(decimals)}`.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function realChargeParts(real: RealCharge | undefined): string[] {
  if (real === undefined) return ['cost not checked'];
  if ('error' in real) return ['cost unavailable'];
  const out = [`${Math.round(real.credits).toLocaleString('en-GB')} credits`];
  if (real.usd !== null) out.push(formatUsd(real.usd));
  // An unknown balance is left off rather than announced.
  if (real.creditsLeft !== null) {
    out.push(`${Math.round(real.creditsLeft).toLocaleString('en-GB')} left this month`);
  }
  return out;
}

/** The one quiet line a session leaves in its chat. */
export function callSummaryLine(c: CallCosting): string {
  const parts = [`Call ${formatDuration(c.endedAt - c.startedAt)}`, engineName(c)];
  if (c.backend === 'elevenlabs') {
    parts.push(...realChargeParts(c.real));
  } else {
    if (c.engineUsd !== null) parts.push(formatUsd(c.engineUsd));
  }
  if (c.tokens) {
    const tin = c.tokens.textIn + c.tokens.audioIn + c.tokens.cachedIn;
    const tout = c.tokens.textOut + c.tokens.audioOut;
    // An engine that reports no tokens says nothing, not "0 tokens".
    if (tin + tout > 0) {
      parts.push(`${tin.toLocaleString('en-GB')} tokens in / ${tout.toLocaleString('en-GB')} out`);
    }
  }
  return parts.join(' · ');
}

/** Total spend of one costed session; an unknown engine price counts as nothing. */
export function callTotalUsd(c: CallCosting): number {
  if (c.real && 'usd' in c.real && c.real.usd !== null) return c.real.usd;
  return c.engineUsd ?? 0;
}

/**
 * Text-to-speech on ElevenLabs. The account is on the Starter plan, $5 for
 * 30,000 credits a month. Flash and Turbo models bill half a credit a
 * character, the others one. A model not in the table is `null` — price
 * unknown — never guessed (NO FALLBACK).
 */
export const ELEVENLABS_USD_PER_CREDIT = 5 / 30_000;
const ELEVENLABS_CREDITS_PER_CHAR: Record<string, number> = {
  eleven_flash_v2_5: 0.5,
  eleven_flash_v2: 0.5,
  eleven_turbo_v2_5: 0.5,
  eleven_turbo_v2: 0.5,
  eleven_multilingual_v2: 1,
  eleven_v3: 1,
};

/** One synthesis request to a paid speech provider, as the ledger keeps it. */
export interface SpeechUsage {
  kind: 'tts';
  provider: 'elevenlabs';
  model: string;
  characters: number;
  at: number;
  /** `null` = the model's price is unknown. */
  usd: number | null;
}

/** ElevenLabs credits one synthesis used; `null` = the model's rate is unknown. */
export function speechCredits(model: string, characters: number): number | null {
  const perChar = ELEVENLABS_CREDITS_PER_CHAR[model];
  return perChar === undefined ? null : characters * perChar;
}

export function speechCostUsd(model: string, characters: number): number | null {
  const perChar = ELEVENLABS_CREDITS_PER_CHAR[model];
  if (perChar === undefined) return null;
  return characters * perChar * ELEVENLABS_USD_PER_CREDIT;
}
