// Voice features are checked when the user engages with them (spec/07 §
// Readiness): a toggle, a call button, the mic. A gap is an invitation with a
// one-step fix, never an error. The requirements are the wire model's, the same
// ones the host refuses by. Nothing known yet (preferences not loaded, host not
// reported) is not a gap: the host decides, and says so in the same words.

import { router, type Href } from 'expo-router';
import {
  dictationEngineFor,
  firstGap,
  type DictationEngine,
  type VoiceFeature,
  type VoiceGap,
} from '@patch/wire/audio';
import { useChatStore } from '../stores/chatStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUiStore } from '../stores/uiStore';
import { voiceAgentOrNull, voiceConfigOrNull } from './preferences';

/**
 * What stops `feature` running now. `hostId` names the host it would run on (a
 * call is on its chat's host); without one, every online host that has reported
 * is asked, since an alert can come from any of them. Null: ready or unknown.
 */
export function voiceGap(feature: VoiceFeature, hostId?: string): VoiceGap | null {
  const config = voiceConfigOrNull();
  const agent = voiceAgentOrNull();
  if (config === null || agent === null) return null;
  const hosts = Object.values(usePresenceStore.getState().hosts)
    .filter((h) => (hostId === undefined ? h.online : h.hostId === hostId))
    .flatMap((h) => (h.host?.voiceKeys ? [h.host] : []));
  return firstGap(feature, { config, agent }, hosts);
}

/** The invitation: what is missing, and a button that opens the fix. */
export function inviteSetup(gap: VoiceGap): void {
  const fix = gap.fix;
  useUiStore
    .getState()
    .pushInvitation(
      gap.message,
      fix === null
        ? undefined
        : { label: 'Set up', run: () => router.push(`/settings/${fix.page}` as Href) },
    );
}

/** True when `feature` can run; otherwise shows the invitation and returns false. */
export function ensureVoiceReady(feature: VoiceFeature, hostId?: string): boolean {
  const gap = voiceGap(feature, hostId);
  if (gap === null) return true;
  inviteSetup(gap);
  return false;
}

/** The engine this phone dictates on: its own choice, else the phone's. */
export function ownDictationEngine(): DictationEngine | null {
  const config = voiceConfigOrNull();
  if (config === null) return null;
  const settings = useSettingsStore.getState().data;
  const own = settings?.devices.find((d) => d.isCurrent)?.surfaceId;
  return dictationEngineFor(config.dictation, 'mobile', {
    surfaceId: own,
    deviceDictation: settings?.preferences.deviceDictation,
  });
}

/** Dictation or a voice note on `chatId`, checked at the press. */
export function ensureDictationReady(chatId: string): boolean {
  const engine = ownDictationEngine();
  if (engine === null) return true;
  return ensureVoiceReady(
    { feature: 'dictation', engine },
    useChatStore.getState().chats[chatId]?.hostId,
  );
}
