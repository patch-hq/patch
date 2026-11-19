// Settings → Dictation: speaking words into the composer — where the words
// come from, when a dictation sends, this host's dictate shortcut, and how
// meetings are transcribed.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import {
  SPEECH_TO_TEXT_LABEL,
  SpeechToTextEngine,
  voiceKeyHostStatus,
  type ComputerDictationEngine,
  type DictationConfig,
  type DictationEngine,
  type MeetingEngine,
  type PhoneDictationEngine,
} from '@patch/wire/audio';
import { DICTATION_PAUSE_CHOICES } from '@patch/wire';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { chordFromEvent, chordGlyphs } from '../../lib/dictateChord.js';
import { getDesktopBridge } from '../../lib/desktopBridge.js';
import { shortcutLabel } from '../../lib/shortcuts.js';
import { reenableSpeakerNames, setNamesDeclined, useMeetingSetup } from '../../lib/meetingSetup.js';
import { Toggle } from '../../components/Toggle.js';
import { patchShared } from './sharedWrite.js';
import { Group, Pills, Row, SettingsPage } from './ui.js';
import { failed } from '../../lib/errorCopy.js';

export function DictationPage(): JSX.Element {
  return (
    <SettingsPage title="Dictation" testid="settings-dictation">
      <SpeechToTextGroup />
      <DictationEnginesGroup />
      <DictationGroup />
      <ShortcutGroup />
      <MeetingEngineGroup />
    </SettingsPage>
  );
}

/** spec/07 § Dictation engines — a computer has no recogniser of its own. */
const PHONE_DICTATION: readonly PhoneDictationEngine[] = [
  'device',
  'deepgram',
  'elevenlabs',
  'host',
  'whisper',
];
const COMPUTER_DICTATION: readonly ComputerDictationEngine[] = [
  'deepgram',
  'elevenlabs',
  'host',
  'local',
  'whisper',
];
const DICTATION_LABELS: Record<DictationEngine, string> = {
  local: 'Parakeet (free, on device)',
  device: 'Built-in',
  deepgram: 'Deepgram',
  elevenlabs: 'ElevenLabs',
  host: 'Host server',
  whisper: 'Whisper',
};

const MEETING_ENGINES: readonly MeetingEngine[] = ['local', 'elevenlabs', 'deepgram', 'assemblyai'];
const MEETING_LABELS: Record<MeetingEngine, string> = {
  local: 'Free, on device',
  elevenlabs: 'ElevenLabs',
  deepgram: 'Deepgram',
  assemblyai: 'AssemblyAI',
};

/**
 * Dictation mode (spec/07 § Dictation mode): whether Smart Turn decides when
 * the speaker has finished, and the silence that sends regardless.
 */
function DictationGroup(): JSX.Element {
  const pause = usePreferencesStore((s) => s.preferences.dictationPauseSeconds);
  const detect = usePreferencesStore((s) => s.preferences.dictationTurnDetection);
  const loaded = usePreferencesStore((s) => s.loaded);
  return (
    <Group label="When to send" testid="settings-voice-dictation">
      <Row title="Detect when I've finished" testid="dictation-turn-detection">
        <Toggle
          checked={detect}
          disabled={!loaded}
          onChange={(next) => void patchShared('turn detection', { dictationTurnDetection: next })}
          testid="dictation-turn-detection-toggle"
        />
      </Row>
      <Row title={detect ? 'Send anyway after a pause of' : 'Send after a pause of'}>
        <Pills
          label="Dictation pause"
          options={DICTATION_PAUSE_CHOICES}
          labels={Object.fromEntries(DICTATION_PAUSE_CHOICES.map((c) => [c, `${c}s`]))}
          value={String(pause) as (typeof DICTATION_PAUSE_CHOICES)[number]}
          disabled={!loaded}
          testid="dictation-pause"
          onChange={(next) =>
            void patchShared('dictation pause', { dictationPauseSeconds: Number(next) })
          }
        />
      </Row>
    </Group>
  );
}

/**
 * The dictate chord, per host (lib/dictateChord.ts). "Change" listens for
 * the next chord with ⌘/Ctrl in it; Esc leaves the old one. The listener runs
 * in the capture phase and stops the event there, so the chord being recorded
 * doesn't also fire whatever it is bound to.
 */
function ShortcutGroup(): JSX.Element {
  const chord = useUiStore((s) => s.dictateChord);
  const setChord = useUiStore((s) => s.setDictateChord);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    function onKey(e: KeyboardEvent): void {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(false);
        return;
      }
      const next = chordFromEvent(e);
      if (!next) return;
      setChord(next);
      setRecording(false);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, setChord]);

  return (
    <Group label="Shortcut" testid="settings-voice-shortcut">
      <Row title="Dictate">
        <kbd className="set-chord" data-testid="dictate-chord">
          {recording ? 'Press keys…' : shortcutLabel(chordGlyphs(chord))}
        </kbd>
        <button
          type="button"
          className="set-btn"
          data-testid="dictate-chord-change"
          aria-pressed={recording}
          onClick={() => setRecording(!recording)}
        >
          {recording ? 'Cancel' : 'Change'}
        </button>
      </Row>
    </Group>
  );
}

/**
 * "Parakeet on this computer": whether the desktop app has its own copy of the
 * models, and the download when it has not. In a browser there is nothing to
 * download into, and the line says so.
 */
function LocalSttStatus(): JSX.Element {
  const stt = getDesktopBridge()?.localStt;
  const [status, setStatus] = useState<{ installed: boolean; downloadBytes: number } | null>(null);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!stt) return;
    stt.status().then(setStatus, (e: Error) => setError(e.message));
  }, [stt]);
  if (!stt) {
    return (
      <span className="set-sub-line set-sub-error" data-testid="dictation-local-status">
        Only runs in the desktop app. Sessions from a browser are refused.
      </span>
    );
  }
  const download = (): void => {
    setError(null);
    setProgress({ received: 0, total: status?.downloadBytes ?? 0 });
    stt
      .download(setProgress)
      .then(() => stt.status())
      .then(setStatus)
      .catch((e: Error) => setError(e.message))
      .finally(() => setProgress(null));
  };
  const mb = (n: number): string => `${Math.round(n / 1_000_000)} MB`;
  return (
    <span className="set-sub-line" data-testid="dictation-local-status">
      {error !== null ? <span className="set-sub-error">{error} </span> : null}
      {progress !== null ? (
        `Downloading ${mb(progress.received)} of ${mb(progress.total)}`
      ) : status === null ? (
        'Checking this computer…'
      ) : status.installed ? (
        'Downloaded on this computer'
      ) : (
        <>
          Not downloaded ({mb(status.downloadBytes)}).{' '}
          <button
            type="button"
            className="set-btn"
            data-testid="dictation-local-download"
            onClick={download}
          >
            Download
          </button>
        </>
      )}
    </span>
  );
}

/**
 * Where dictation's words come from (spec/07 § Dictation engines): one engine
 * for the phone app, one for web and desktop, and whether Whisper tidies up a
 * live engine's words as dictation goes on.
 */
/** What reads speech on turn-based calls and tidies dictation (spec/07 § Speech to text). */
function SpeechToTextGroup(): JSX.Element {
  const voiceConfig = usePreferencesStore((s) => s.preferences.voiceConfig);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);
  return (
    <Group label="Speech to text" testid="settings-voice-stt">
      <Row title="Reads speech with" testid="stt-row">
        <Pills
          label="Speech to text"
          options={SpeechToTextEngine.options}
          labels={SPEECH_TO_TEXT_LABEL}
          value={voiceConfig.speechToText}
          disabled={!loaded}
          testid="stt-engine"
          onChange={(speechToText) => {
            void update({ voiceConfig: { ...voiceConfig, speechToText } }).catch((e: Error) =>
              pushError(failed('settings'), undefined, e.message),
            );
          }}
        />
      </Row>
    </Group>
  );
}

function DictationEnginesGroup(): JSX.Element {
  const dictation = usePreferencesStore((s) => s.preferences.voiceConfig.dictation);
  const voiceConfig = usePreferencesStore((s) => s.preferences.voiceConfig);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);
  const hosts = usePresenceStore((s) => s.hosts);
  const hostReports = Object.values(hosts).flatMap((h) =>
    h.host ? [{ hostName: h.host.hostName, voiceKeys: h.host.voiceKeys }] : [],
  );
  const write = (patch: Partial<DictationConfig>): void => {
    void update({ voiceConfig: { ...voiceConfig, dictation: { ...dictation, ...patch } } }).catch(
      (e: Error) => pushError(failed('settings'), undefined, e.message),
    );
  };
  // A Deepgram choice names each host that holds no key for it.
  const keys = (engine: DictationEngine, testid: string): JSX.Element | undefined => {
    const status = voiceKeyHostStatus(engine, hostReports);
    return status ? (
      <span className="set-sub-line set-sub-error" data-testid={testid}>
        {status}
      </span>
    ) : undefined;
  };
  return (
    <Group label="Engine" testid="settings-voice-dictation-engines">
      <Row
        title="Phone"
        sub={keys(dictation.phone, 'dictation-phone-keys')}
        testid="dictation-phone"
      >
        <Pills
          label="Phone dictation"
          options={PHONE_DICTATION}
          labels={DICTATION_LABELS}
          value={dictation.phone}
          disabled={!loaded}
          testid="dictation-phone-engine"
          onChange={(phone) => write({ phone })}
        />
      </Row>
      <Row
        title="Computer"
        sub={
          dictation.computer === 'local' ? (
            <LocalSttStatus />
          ) : (
            keys(dictation.computer, 'dictation-computer-keys')
          )
        }
        testid="dictation-computer"
      >
        <Pills
          label="Computer dictation"
          options={COMPUTER_DICTATION}
          labels={DICTATION_LABELS}
          value={dictation.computer}
          disabled={!loaded}
          testid="dictation-computer-engine"
          onChange={(computer) => write({ computer })}
        />
      </Row>
      <Row
        title={`Tidy up each phrase with ${SPEECH_TO_TEXT_LABEL[voiceConfig.speechToText]}`}
        testid="dictation-tidy-row"
      >
        <Toggle
          checked={dictation.tidy}
          disabled={!loaded}
          onChange={(tidy) => write({ tidy })}
          testid="dictation-tidy-toggle"
        />
      </Row>
    </Group>
  );
}

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
    <Group label="Meetings" testid="settings-voice-meeting">
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
