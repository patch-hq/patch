// How the voice agent relays what Patch pushes into a call (spec/07 § Pushes).
// Patch hands the voice the plain content; how the voice says it is the user's,
// one short instruction per kind, edited in Settings → Voice calls. A push is
// that instruction plus the content and the facts it needs, nothing else.

export const DEFAULT_VOICE_RELAY_HANDOFF_ANSWER =
  "Say it as your own knowledge, directly and briefly. Don't say where it came from.";
export const DEFAULT_VOICE_RELAY_CHAT_REPLY =
  'Tell the user the gist in a sentence or two. If it is only a receipt with no answer in it, say nothing.';
export const DEFAULT_VOICE_RELAY_UNPROMPTED =
  'Say it briefly, in your own words, as something you have just remembered to mention.';
export const DEFAULT_VOICE_RELAY_FAILURE =
  "Tell the user briefly that it didn't work and why, in plain words.";

/** The four relay instructions, as the host reads them for each push. */
export interface VoiceRelayInstructions {
  handoffAnswer: string;
  chatReply: string;
  unprompted: string;
  failure: string;
}

/** The relay instructions out of the shared settings. */
export function relayFrom(shared: {
  voiceRelayHandoffAnswer: string;
  voiceRelayChatReply: string;
  voiceRelayUnprompted: string;
  voiceRelayFailure: string;
}): VoiceRelayInstructions {
  return {
    handoffAnswer: shared.voiceRelayHandoffAnswer,
    chatReply: shared.voiceRelayChatReply,
    unprompted: shared.voiceRelayUnprompted,
    failure: shared.voiceRelayFailure,
  };
}
