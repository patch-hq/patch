// spec/07 § Call cost — what one sustained voice session used and what it cost.
//
// Prices are a fixed table per model, in US dollars per million tokens, as
// published by each provider (checked 2026-10-04). A model that is not in the
// table is costed as `null` — "price unknown" — never guessed (NO FALLBACK).

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

/**
 * ElevenLabs Agents bill by call minute, not by token: $0.08 a minute on every
 * plan (elevenlabs.io/pricing/agents, checked 2026-10-29; $0.16 in burst), plus
 * the front LLM's own per-minute charge, which is taken from credits. An LLM
 * that is not in this table makes the call `null` — price unknown.
 * Claude Haiku 4.5's figure is the one third-party-quoted rate; Sonnet's is not
 * published as a per-minute number, so it stays unknown until it is.
 */
export const ELEVENLABS_AGENT_USD_PER_MINUTE = 0.08;
const ELEVENLABS_LLM_USD_PER_MINUTE: Record<string, number> = {
  'claude-haiku-4-5': 0.0082,
};

/** Dollar cost of `seconds` of an ElevenLabs agent call on `llm`, or `null` when the LLM's rate is unknown. */
export function elevenLabsCostUsd(llm: string, seconds: number): number | null {
  const llmRate = ELEVENLABS_LLM_USD_PER_MINUTE[llm];
  if (llmRate === undefined) return null;
  return (seconds / 60) * (ELEVENLABS_AGENT_USD_PER_MINUTE + llmRate);
}

/** Groq `whisper-large-v3-turbo`: $0.04 per hour, each request billed for at least 10s. */
export const GROQ_WHISPER_USD_PER_SECOND = 0.04 / 3600;
export const GROQ_MIN_BILLED_SECONDS = 10;

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

export function sttCostUsd(stt: SttUsage): number {
  return stt.billedSeconds * GROQ_WHISPER_USD_PER_SECOND;
}

/** What the session's engine reports on close. */
export interface EngineCosting {
  backend: 'local' | 'gemini' | 'openai' | 'elevenlabs';
  model: string;
  tokens: EngineTokens | null;
  stt: SttUsage | null;
  /** ElevenLabs only: seconds the agent conversation was open (what it bills by). */
  agentSeconds?: number;
}

/** One costed session, as stored on disk and summarised into the chat. */
export interface CallCosting {
  sessionId: string;
  chatId: string;
  surfaceKind: string;
  startedAt: number;
  endedAt: number;
  backend: 'local' | 'gemini' | 'openai' | 'elevenlabs';
  model: string;
  tokens: EngineTokens | null;
  stt: SttUsage | null;
  agentSeconds?: number;
  /** `null` = the engine's price is unknown. */
  engineUsd: number | null;
  /** Requests the fast voice handed to the chat's agent; absent on records from before this was counted. */
  handoffs?: number;
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
    engineUsd = engine.stt ? sttCostUsd(engine.stt) : 0;
  } else if (engine.backend === 'elevenlabs') {
    engineUsd = elevenLabsCostUsd(engine.model, engine.agentSeconds ?? 0);
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
    engineUsd,
    handoffs: args.handoffs,
  };
}

const ENGINE_NAMES: Record<string, string> = {
  'gemini-2.5-flash-native-audio-preview-12-2025': 'Gemini Flash',
  'gemini-3.8-live-extended-thinking': 'Gemini Thinking',
  'gpt-realtime-2.1': 'OpenAI',
  'gpt-realtime-2.1-mini': 'OpenAI mini',
  'claude-haiku-4-5': 'ElevenLabs Haiku',
  'claude-sonnet-4-5': 'ElevenLabs Sonnet',
};

function engineName(c: CallCosting): string {
  if (c.backend === 'local') return 'Local';
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

/** The one quiet line a session leaves in its chat. */
export function callSummaryLine(c: CallCosting): string {
  const parts = [
    `Call ${formatDuration(c.endedAt - c.startedAt)}`,
    engineName(c),
    c.engineUsd === null ? 'price unknown' : formatUsd(c.engineUsd),
  ];
  if (c.tokens) {
    const tin = c.tokens.textIn + c.tokens.audioIn + c.tokens.cachedIn;
    const tout = c.tokens.textOut + c.tokens.audioOut;
    parts.push(`${tin.toLocaleString('en-GB')} tokens in / ${tout.toLocaleString('en-GB')} out`);
  }
  // Only a fast voice hands anything off; a call that reads 0 here but made requests is the tell.
  if (c.backend !== 'local' && c.handoffs !== undefined) {
    parts.push(`${c.handoffs} ${c.handoffs === 1 ? 'hand-off' : 'hand-offs'}`);
  }
  return parts.join(' · ');
}

/** Total spend of one costed session; an unknown engine price counts as nothing. */
export function callTotalUsd(c: CallCosting): number {
  return c.engineUsd ?? 0;
}
