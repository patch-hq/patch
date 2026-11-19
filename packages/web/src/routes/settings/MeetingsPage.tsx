// Settings → Meetings: how a meeting is transcribed, and whether Patch names
// who is speaking.

import type { JSX } from 'react';
import { voiceKeyHostStatus, type MeetingEngine } from '@patch/wire/audio';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { getDesktopBridge } from '../../lib/desktopBridge.js';
import { reenableSpeakerNames, setNamesDeclined, useMeetingSetup } from '../../lib/meetingSetup.js';
import { Toggle } from '../../components/Toggle.js';
import { Group, Pills, Row, SettingsPage } from './ui.js';
import { failed } from '../../lib/errorCopy.js';

export function MeetingsPage(): JSX.Element {
  return (
    <SettingsPage title="Meetings" testid="settings-meetings">
      <MeetingEngineGroup />
    </SettingsPage>
  );
}

const MEETING_ENGINES: readonly MeetingEngine[] = ['local', 'elevenlabs', 'deepgram', 'assemblyai'];
const MEETING_LABELS: Record<MeetingEngine, string> = {
  local: 'Parakeet (free, on device)',
  elevenlabs: 'ElevenLabs',
  deepgram: 'Deepgram',
  assemblyai: 'AssemblyAI',
};

/**
 * Who transcribes a meeting. On this computer is free; the others are paid and
 * chosen deliberately — a meeting is hours of audio.
 */
function MeetingEngineGroup(): JSX.Element {
  const voiceConfig = usePreferencesStore((s) => s.preferences.voiceConfig);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);
  const hosts = usePresenceStore((s) => s.hosts);
  const hostReports = Object.values(hosts).flatMap((h) =>
    h.host ? [{ hostName: h.host.hostName, voiceKeys: h.host.voiceKeys }] : [],
  );
  const status = voiceKeyHostStatus(voiceConfig.meeting, hostReports);
  return (
    <Group testid="settings-voice-meeting">
      <Row
        title="Transcription"
        sub={
          status ? (
            <span className="set-sub-line set-sub-error" data-testid="meeting-engine-keys">
              {status}
            </span>
          ) : undefined
        }
        testid="meeting-engine"
      >
        <Pills
          label="Meeting transcription"
          options={MEETING_ENGINES}
          labels={MEETING_LABELS}
          value={voiceConfig.meeting}
          disabled={!loaded}
          testid="meeting-engine-pills"
          onChange={(meeting) =>
            void update({ voiceConfig: { ...voiceConfig, meeting } }).catch((e: Error) =>
              pushError(failed('settings'), undefined, e.message),
            )
          }
        />
      </Row>
      <MeetingNamesRow />
    </Group>
  );
}

/** Meeting mode: whether Patch asks for Accessibility to name who is speaking. Desktop only. */
function MeetingNamesRow(): JSX.Element | null {
  const declined = useMeetingSetup((s) => s.namesDeclined);
  if (!getDesktopBridge()?.getMeetingPermissions) return null;
  return (
    <Row
      title="Name speakers on calls"
      sub="Reads Teams, Zoom and Meet through macOS Accessibility. Off, speakers show as Unknown."
      testid="meeting-names-row"
    >
      <Toggle
        checked={!declined}
        onChange={(next) => {
          if (next) void reenableSpeakerNames();
          else setNamesDeclined(true);
        }}
        testid="meeting-names-toggle"
      />
    </Row>
  );
}
