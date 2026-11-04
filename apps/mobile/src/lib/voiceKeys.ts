// Whether this phone already knows a voice surface cannot run for a chat: the
// surface is configured onto a hosted backend and the chat's host has reported
// (`host.host.voiceKeys`) that it holds no key for it. The host is the
// authority and refuses such a session itself with the same sentence; this
// only lets a gesture with no session behind it until release — a voice note,
// a dictation — fail at the press instead of after the user has spoken.
// Nothing is known (config not loaded, host not reported, chat not pinned to a
// host yet) → null, and the host decides.

import { voiceCellFor, voiceKeyMissingMessage, type VoiceSurface } from '@patch/wire/audio';
import { useChatStore } from '../stores/chatStore';
import { usePresenceStore } from '../stores/presenceStore';
import { voiceConfigOrNull } from './preferences';

export function voiceKeyRefusal(chatId: string, surface: VoiceSurface): string | null {
  const config = voiceConfigOrNull();
  if (config === null) return null;
  // Dictation from this phone runs on the phone's engine; only Deepgram needs a key.
  const backend =
    surface === 'dictation' ? config.dictation.phone : voiceCellFor(config, surface).backend;
  if (backend === 'local' || backend === 'device' || backend === 'host' || backend === 'whisper') {
    return null;
  }
  const hostId = useChatStore.getState().chats[chatId]?.hostId;
  if (!hostId) return null;
  const keys = usePresenceStore.getState().hosts[hostId]?.host?.voiceKeys;
  if (!keys || keys[backend] === true) return null;
  return voiceKeyMissingMessage(surface, backend);
}
