// Keeping a call's live context bounded (spec/07 § Call cost → Context).
//
// Every turn and every pushed answer lands in the provider's conversation, and
// the provider bills the whole conversation again on each turn, so an unbounded
// call gets dearer and slower as it goes. Each provider's own mechanism rolls
// the oldest turns off while the start context (the instructions) stays:
//
// - Gemini Live: `contextWindowCompression.slidingWindow`. It takes no number;
//   Google's trigger and target defaults apply (the trigger is a share of the
//   model's window), so the mode is the recommended one and nothing is tuned.
// - OpenAI Realtime: session `truncation` of type `retention_ratio`. It needs
//   numbers: the share kept when it truncates, and a cap on the input tokens
//   after the instructions that a response may carry.
// - ElevenLabs Agents: has no context setting. Its LLM context is held by
//   ElevenLabs and it reports no per-turn size, so a call there is billed by
//   the minute (spec/07 § The voice agent) and nothing is trimmed or logged.

/** Gemini Live `setup.contextWindowCompression`: sliding window, provider defaults. */
export const GEMINI_CONTEXT_COMPRESSION = { slidingWindow: {} } as const;

/** Input tokens after the instructions a single OpenAI response may carry (about the last few minutes of talk). */
export const OPENAI_CONTEXT_POST_INSTRUCTIONS_TOKENS = 8000;

/** Share of the conversation OpenAI keeps when it truncates; below 1 so it makes headroom and truncates rarely (every truncation breaks prompt caching). */
export const OPENAI_CONTEXT_RETENTION_RATIO = 0.8;

/** OpenAI Realtime `session.truncation`. */
export const OPENAI_TRUNCATION = {
  type: 'retention_ratio',
  retention_ratio: OPENAI_CONTEXT_RETENTION_RATIO,
  token_limits: { post_instructions: OPENAI_CONTEXT_POST_INSTRUCTIONS_TOKENS },
} as const;
