// Voice features are checked when the user engages with them (spec/07 §
// Readiness): a toggle, a call button, a Settings row. A gap is an invitation
// with a one-step fix, never an error. The requirements are the wire model's,
// the same ones the host refuses by.

import { firstGap, type VoiceFeature, type VoiceGap } from '@patch/wire/audio';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { appNavigate } from './appNavigate.js';

/**
 * What stops `feature` running now. `hostId` names the host it would run on (a
 * call is on its chat's host); without one, every online host that has reported
 * is asked, since an alert can come from any of them. Null: ready.
 */
export function voiceGap(feature: VoiceFeature, hostId?: string): VoiceGap | null {
  const { voiceConfig, voiceAgent } = usePreferencesStore.getState().preferences;
  const hosts = Object.values(usePresenceStore.getState().hosts)
    .filter((h) => (hostId === undefined ? h.online : h.hostId === hostId))
    .flatMap((h) => (h.host?.voiceKeys ? [h.host] : []));
  return firstGap(feature, { config: voiceConfig, agent: voiceAgent }, hosts);
}

/** The invitation: what is missing, and a button that opens the fix. */
export function inviteSetup(gap: VoiceGap): void {
  const fix = gap.fix;
  useUiStore
    .getState()
    .pushNotice(
      gap.message,
      fix === null
        ? undefined
        : { label: 'Set up', run: () => appNavigate(`/settings/${fix.page}`) },
    );
}

/** True when `feature` can run; otherwise shows the invitation and returns false. */
export function ensureVoiceReady(feature: VoiceFeature, hostId?: string): boolean {
  const gap = voiceGap(feature, hostId);
  if (gap === null) return true;
  inviteSetup(gap);
  return false;
}
