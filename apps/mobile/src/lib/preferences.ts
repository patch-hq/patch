// The account preferences the phone reads (spec/14 § `/settings` details).
//
// Three of them matter to a voice session. The address word a quiet call gates
// utterances on (spec/07 § Session modes), the voice config (dictation and
// voice devices) and the voice agent setup (spec/07 § The voice agent). The
// HOST is what picks the engine for a session; the phone reads the setup only
// to name the provider and model on the call bar. They are cached at boot so
// opening a call needs no round-trip, and NOT defaulted — until the server has
// actually answered, a session carries no address word rather than a guess the
// host would enforce, and the call bar names no engine rather than a guess.

import type { VoiceAgentSetting, VoiceConfig } from '@patch/wire/audio';
import { api, type AccountPreferences } from '../api/rest';
import { useSettingsStore } from '../stores/settingsStore';

let addressWord: string | null = null;
let voiceConfig: VoiceConfig | null = null;
let voiceAgent: VoiceAgentSetting | null = null;
let verbosity: AccountPreferences['providerContextVerbosity'] = 'summary';

export async function loadPreferences(): Promise<void> {
  const settings = await api.settings();
  if (!settings.preferences) throw new Error('server returned no account preferences');
  addressWord = settings.preferences.addressWord;
  voiceConfig = settings.preferences.voiceConfig;
  voiceAgent = settings.preferences.voiceAgent;
  verbosity = settings.preferences.providerContextVerbosity;
}

/**
 * The address word, or null until the preferences have actually loaded. A
 * Settings load or edit since boot is newer than the boot-time read, so it wins.
 */
export function addressWordOrNull(): string | null {
  return useSettingsStore.getState().data?.preferences.addressWord ?? addressWord;
}

/**
 * Pause when quiet for, in minutes (spec/07 § Pause): 0 (off) until the
 * preferences have loaded, so a call never pauses on a guess.
 */
export function pauseWhenQuietMinutes(): number {
  return useSettingsStore.getState().data?.preferences.pauseWhenQuietMinutes ?? 0;
}

/** The account's voice config, or null until the preferences have loaded. Same precedence. */
export function voiceConfigOrNull(): VoiceConfig | null {
  return useSettingsStore.getState().data?.preferences.voiceConfig ?? voiceConfig;
}

/** The account's voice agent setup, or null until the preferences have loaded. Same precedence. */
export function voiceAgentOrNull(): VoiceAgentSetting | null {
  return useSettingsStore.getState().data?.preferences.voiceAgent ?? voiceAgent;
}

/**
 * The provider-level context bar's default expand state, as read at boot.
 * `summary` until then — the account's own default, and the setting that
 * hides nothing and opens nothing (spec/02 § Provider-level context).
 */
export function providerContextVerbosity(): AccountPreferences['providerContextVerbosity'] {
  return verbosity;
}

/** Test seam: forget the boot-time read. */
export function __resetPreferences(): void {
  addressWord = null;
  voiceConfig = null;
  voiceAgent = null;
  verbosity = 'summary';
}
