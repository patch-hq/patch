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
import {
  DEFAULT_MEETING_ACTIONS_PROMPT,
  DEFAULT_MEETING_NOTES_PROMPT,
  DEFAULT_MEETING_NOW_PROMPT,
} from '@patch/wire';
import { MeetingModelRows, MeetingTimingRows } from './MeetingRows.js';
import { PromptRow } from './PromptRow.js';
import { patchShared } from './sharedWrite.js';

export function MeetingsPage(): JSX.Element {
  return (
    <SettingsPage
      title="Meetings"
      intro="Live notes, actions and research while you're in a meeting."
      testid="settings-meetings"
    >
      <MeetingEngineGroup />
      <Group label="Models" testid="settings-meeting-models">
        <MeetingModelRows />
      </Group>
      <Group label="Timing" testid="settings-meeting-timing">
        <MeetingTimingRows />
      </Group>
      <MeetingPromptsGroup />
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

/** The three meeting-analysis instructions; the speaker rules and reply shape stay fixed so it parses. */
function MeetingPromptsGroup(): JSX.Element {
  const p = usePreferencesStore((s) => s.preferences);
  return (
    <Group label="Prompts" testid="settings-meeting-prompts">
      <PromptRow
        id="meeting-now"
        title="Now"
        sub="How the live Now block is written."
        defaultText={DEFAULT_MEETING_NOW_PROMPT}
        current={p.meetingNowPrompt}
        onSave={(text) => patchShared('meeting: now prompt', { meetingNowPrompt: text })}
        onDefault={() =>
          patchShared('meeting: now prompt', { meetingNowPrompt: DEFAULT_MEETING_NOW_PROMPT })
        }
      />
      <PromptRow
        id="meeting-notes"
        title="Notes"
        sub="How the key points are written and condensed."
        defaultText={DEFAULT_MEETING_NOTES_PROMPT}
        current={p.meetingNotesPrompt}
        onSave={(text) => patchShared('meeting: notes prompt', { meetingNotesPrompt: text })}
        onDefault={() =>
          patchShared('meeting: notes prompt', { meetingNotesPrompt: DEFAULT_MEETING_NOTES_PROMPT })
        }
      />
      <PromptRow
        id="meeting-actions"
        title="Actions"
        sub="What counts as an action."
        defaultText={DEFAULT_MEETING_ACTIONS_PROMPT}
        current={p.meetingActionsPrompt}
        onSave={(text) => patchShared('meeting: actions prompt', { meetingActionsPrompt: text })}
        onDefault={() =>
          patchShared('meeting: actions prompt', {
            meetingActionsPrompt: DEFAULT_MEETING_ACTIONS_PROMPT,
          })
        }
      />
    </Group>
  );
}
