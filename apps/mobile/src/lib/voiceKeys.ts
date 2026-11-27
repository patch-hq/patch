// Whether this phone already knows a voice surface cannot run for a chat: the
// surface is configured onto a hosted backend and the chat's host has reported
// (`host.host.voiceKeys`) that it holds no key for it. The host is the
// authority and refuses such a session itself with the same sentence; this
// only lets a gesture with no session behind it until release — a voice note,
// a dictation — fail at the press instead of after the user has spoken.
// Nothing is known (config not loaded, host not reported, chat not pinned to a
// host yet) → null, and the host decides.

import {
  voiceBackendFor,
  voiceKeyMissingMessage,
  type DictationEngine,
  type VoiceBackend,
  type VoiceSurface,
} from '@patch/wire/audio';
import { useChatStore } from '../stores/chatStore';
import { usePresenceStore } from '../stores/presenceStore';
import { voiceAgentOrNull, voiceConfigOrNull } from './preferences';
import { useSettingsStore } from '../stores/settingsStore';

export function voiceKeyRefusal(chatId: string, surface: VoiceSurface): string | null {
  const config = voiceConfigOrNull();
  if (config === null) return null;
  // Dictation from this phone runs on the phone's engine; only Deepgram needs a key.
  let backend: VoiceBackend | DictationEngine;
  if (surface === 'dictation') {
    const settings = useSettingsStore.getState().data;
    const own = settings?.devices.find((d) => d.isCurrent)?.surfaceId;
    backend =
      (own !== undefined ? settings?.preferences.deviceDictation?.[own] : undefined) ??
      config.dictation.phone;
  } else if (surface === 'announcement') {
    // Spoken on the host's own speech engine: no provider key.
    return null;
  } else {
    const agent = voiceAgentOrNull();
    if (agent === null) return null;
    backend = voiceBackendFor(config, agent, surface);
  }
  if (backend === 'local' || backend === 'device' || backend === 'host' || backend === 'whisper') {
    return null;
  }
  const hostId = useChatStore.getState().chats[chatId]?.hostId;
  if (!hostId) return null;
  const keys = usePresenceStore.getState().hosts[hostId]?.host?.voiceKeys;
  if (!keys || keys[backend] === true) return null;
  return voiceKeyMissingMessage(surface, backend);
}
