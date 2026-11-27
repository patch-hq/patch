// Which voice engine a phone session is on, and how its failures read
// (spec/07 § Voice — a config matrix; spec/15 § Voice states).
//
// The phone never talks to Gemini or OpenAI itself and holds no provider key
// or token: every backend rides the same host audio WSS, and the host picks
// the engine per session from the account's voice config. So nothing here
// chooses an engine — it only names the one the config says a session is on,
// so the call bar can say "Gemini Live · heavy" while the line is paid for,
// and turns a hosted engine's failure into a sentence that says which engine
// failed instead of a bare error code.

import {
  VOICE_AGENT_PROVIDER_LABEL,
  type AudioErrorCode,
  type VoiceAgentSetting,
} from '@patch/wire/audio';

/**
 * What the call bar names a voice agent call by (spec/15 § Voice states): the
 * provider and the model, `Gemini · gemini-2.5-flash-native-audio`. Null until
 * the setup has loaded (no guess) and when no model is chosen (the host
 * refuses that call and says so).
 */
export function callEngineLabel(agent: VoiceAgentSetting | null): string | null {
  if (agent === null) return null;
  const model = agent.setups[agent.provider].model;
  if (model === undefined) return null;
  return `${VOICE_AGENT_PROVIDER_LABEL[agent.provider]} · ${model.replace(/^models\//, '')}`;
}

/**
 * The sentence an `audio.error` becomes on the call bar. A hosted engine's
 * failure names the engine — it is never answered by quietly running the local
 * pipeline instead, so the user has to be able to tell that the configured
 * engine is what broke.
 */
export function describeVoiceError(code: AudioErrorCode, message: string): string {
  switch (code) {
    case 'gemini_unavailable':
      return `Gemini Live failed — ${message}`;
    case 'openai_unavailable':
      return `OpenAI Realtime failed — ${message}`;
    case 'voice_key_missing':
    case 'mic_silent':
      // Already the whole sentence, with the fix.
      return message;
    case 'voice_config_not_implemented':
      return `Not available with this voice setting — ${message}`;
    default:
      return `${code}: ${message}`;
  }
}

/**
 * The call-bar sentence for a silent microphone, decided by what the phone
 * actually holds. The host only sees silence and cannot tell a revoked
 * permission from another app (or a Bluetooth headset) holding the mic, so a
 * granted permission must not be blamed. A missing one is asked for in place
 * rather than sending the user to Settings.
 */
export async function describeMicSilent(
  hostMessage: string,
  deps: { has: () => Promise<boolean>; ask: () => Promise<boolean> },
): Promise<string> {
  if (await deps.has()) {
    return (
      'Your microphone is sending silence, though Patch is allowed to use it. Another app may be ' +
      'holding the microphone, or a Bluetooth headset may be capturing it. End the call and start it again.'
    );
  }
  if (await deps.ask()) {
    return 'Microphone access was missing and is now allowed. End the call and start it again.';
  }
  return hostMessage;
}
