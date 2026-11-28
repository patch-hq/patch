// Settings → Manager, Settings → Dictation and Settings → Voice (design/settings-redesign).
//
// Manager — the Manager's own switches (Enabled, Quiet hours, Address word),
// then the model the Manager and Speakers threads run on and their daily
// fresh session. Account-wide (`GET`/`PATCH /api/settings`): the loops that
// act on them run on the server. Each write settles on the server's answer; a
// failed write is said out loud and the control keeps showing what the server
// holds.
//
// Dictation — where each device's dictated words come from, and when a
// dictation sends. Meetings — how a meeting is transcribed.
//
// Voice calls — the voice agent, Agents calling you and Calls
// (VoiceAgentSection.tsx), then what voice has used, and voice devices with
// how they answer.

import React from 'react';
import { Alert, Text, View } from 'react-native';
import { api, type AccountPreferences } from '../../api/rest';
import { space, typography, useTheme } from '../../lib/theme';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePresenceStore } from '../../stores/presenceStore';
import {
  SPEECH_TO_TEXT_LABEL,
  SpeechToTextEngine,
  dictationEnginesFor,
  voiceKeyHostStatus,
  type AudioSurfaceKind,
  type DictationEngine,
  type MeetingEngine,
} from '@patch/wire/audio';
import {
  DICTATION_PAUSE_CHOICES,
  MANAGER_WAKE_INTERVAL_CHOICES,
  ManagerWake,
  SPECIAL_THREAD_IDS,
  SpeechBackendSetting,
} from '@patch/wire';
type DictationPauseChoice = (typeof DICTATION_PAUSE_CHOICES)[number];
import { SettingsSection } from '../SettingsSection';
import { VoiceDevicesSection } from './DevicesSections';
import { AgentsCallingSection, CallsSection, VoiceAgentSection } from './VoiceAgentSection';
import { patchShared } from './sharedWrite';
import { ModelChoice } from './ModelChoice';
import { ManagerHomeSection } from './ManagerHomeSection';
import { SettingsPage } from './SettingsPage';
import { MeetingControls, TextPromptLink } from './PromptRows';
import { Chips, Field, Muted, Row, SettingsButton, ToggleRow, WithSettings } from './ui';

/** Write a preferences patch; a failure is reported, never swallowed. */
export function writePreferences(patch: Partial<AccountPreferences>): void {
  void useSettingsStore
    .getState()
    .updatePreferences(patch)
    .catch((e: Error) => Alert.alert('Settings failed', e.message));
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * An `HH:MM` field that commits on blur. A value that is not a time is refused
 * with a message and the field returns to what the server holds.
 */
function TimeField({
  value,
  testID,
  label,
  onCommit,
}: {
  value: string;
  testID: string;
  label: string;
  onCommit: (next: string) => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  return (
    <Field
      testID={testID}
      accessibilityLabel={label}
      value={draft}
      onChangeText={setDraft}
      keyboardType="numbers-and-punctuation"
      placeholder="HH:MM"
      style={{ width: 72, textAlign: 'center' }}
      onBlur={() => {
        const next = draft.trim();
        if (next === value) return;
        if (!HHMM.test(next)) {
          Alert.alert('Invalid time', `${label} must be a 24-hour time like 07:30.`);
          setDraft(value);
          return;
        }
        onCommit(next);
      }}
    />
  );
}

// ── Manager ──────────────────────────────────────────────────────────────────

export function ManagerPage(): React.ReactElement {
  return (
    <SettingsPage title="Manager" testID="settings-page-manager">
      <WithSettings testID="manager">
        {(data) => (
          <>
            <ManagerHomeSection />
            <SettingsSection title="Prompts" testID="settings-manager-prompts">
              <TextPromptLink layer="manager" preferences={data.preferences} />
              <TextPromptLink layer="manager-voice" preferences={data.preferences} />
            </SettingsSection>
            <SettingsSection title="Finished chats" testID="settings-manager-wake">
              <FinishedChatsControls preferences={data.preferences} />
            </SettingsSection>
            <SettingsSection title="Context" testID="settings-manager-context">
              <ManagerSessionRow />
              <ContextWindowRow value={data.preferences.managerContextWindow} />
            </SettingsSection>
            <SettingsSection title="Manager" testID="settings-manager">
              <ManagerControls preferences={data.preferences} />
            </SettingsSection>
            <SettingsSection title="Manager and Speakers threads" testID="settings-special-threads">
              <ModelChoice
                label="Model"
                testID="special-thread-model"
                value={data.preferences.specialThreadModel}
                onSelect={(id) => writePreferences({ specialThreadModel: id })}
              />
              <ToggleRow
                label="Start a fresh session daily"
                testID="rotation-enabled"
                value={data.preferences.rotationEnabled}
                onChange={(next) => writePreferences({ rotationEnabled: next })}
              />
              <Row
                title="At"
                right={
                  <TimeField
                    testID="rotation-time"
                    label="Fresh session at"
                    value={data.preferences.rotationTime}
                    onCommit={(v) => writePreferences({ rotationTime: v })}
                  />
                }
              />
            </SettingsSection>
          </>
        )}
      </WithSettings>
    </SettingsPage>
  );
}

function ManagerControls({ preferences }: { preferences: AccountPreferences }): React.ReactElement {
  const [addressWord, setAddressWord] = React.useState(preferences.addressWord);
  // Track the server's value until the field is edited, so a later load is not
  // left showing a stale word.
  React.useEffect(() => setAddressWord(preferences.addressWord), [preferences.addressWord]);
  return (
    <>
      <Row
        title="Quiet hours"
        right={
          <>
            <TimeField
              testID="manager-quiet-start"
              label="Quiet hours start"
              value={preferences.quietHoursStart}
              onCommit={(v) => writePreferences({ quietHoursStart: v })}
            />
            <Muted>–</Muted>
            <TimeField
              testID="manager-quiet-end"
              label="Quiet hours end"
              value={preferences.quietHoursEnd}
              onCommit={(v) => writePreferences({ quietHoursEnd: v })}
            />
          </>
        }
      />
      <Row
        title="Address word"
        right={
          <Field
            testID="manager-address-word"
            accessibilityLabel="Address word"
            value={addressWord}
            onChangeText={setAddressWord}
            style={{ width: 120 }}
            onBlur={() => {
              const next = addressWord.trim();
              if (next === '' || next === preferences.addressWord) {
                setAddressWord(preferences.addressWord);
                return;
              }
              writePreferences({ addressWord: next });
            }}
          />
        }
      />
    </>
  );
}

const WAKE_LABELS: Record<ManagerWake, string> = {
  off: 'Off',
  each: 'Each one',
  batched: 'Batched',
};

/** A batch interval as Settings names it: 30 min, 2 h, a day. */
export function intervalLabel(minutes: number): string {
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} min`;
  return minutes === 1440 ? 'a day' : `${minutes / 60} h`;
}

/** Finished chats → the Manager (spec/06 § Finished chats): when, and how often batched. */
function FinishedChatsControls({
  preferences,
}: {
  preferences: AccountPreferences;
}): React.ReactElement {
  const intervals = MANAGER_WAKE_INTERVAL_CHOICES.map(String);
  const current = String(preferences.managerWakeIntervalMinutes);
  return (
    <>
      <Row testID="manager-wake" title="Send to the Manager" stack>
        <Muted>Chats with a goal running are left out</Muted>
        <Chips
          options={ManagerWake.options}
          selected={preferences.managerWake}
          labelOf={(w) => WAKE_LABELS[w]}
          testIDPrefix="manager-wake-mode"
          labelPrefix="Send finished chats"
          onSelect={(w) => writePreferences({ managerWake: w })}
        />
      </Row>
      {preferences.managerWake === 'batched' ? (
        <Row testID="manager-wake-interval" title="Every" stack>
          <Chips
            options={intervals.includes(current) ? intervals : [...intervals, current]}
            selected={current}
            labelOf={(m) => intervalLabel(Number(m))}
            testIDPrefix="manager-wake-interval"
            labelPrefix="Batch every"
            onSelect={(m) => writePreferences({ managerWakeIntervalMinutes: Number(m) })}
          />
        </Row>
      ) : null}
    </>
  );
}

/** Context → This session (spec/06 § Bounded context), with Clear. */
function ManagerSessionRow(): React.ReactElement {
  const [session, setSession] = React.useState<
    { messages: number; startedAt: number } | null | undefined | 'error'
  >(undefined);
  const load = React.useCallback(() => {
    api
      .getChatSession(SPECIAL_THREAD_IDS.manager)
      .then((r) => setSession(r.session ?? null))
      .catch(() => setSession('error'));
  }, []);
  React.useEffect(load, [load]);
  const text =
    session === 'error'
      ? 'Could not read the session'
      : session === undefined
        ? 'Loading…'
        : session === null
          ? 'No session yet'
          : `${session.messages} message${session.messages === 1 ? '' : 's'} · started ${new Date(
              session.startedAt,
            ).toLocaleString([], {
              hour: '2-digit',
              minute: '2-digit',
              day: 'numeric',
              month: 'short',
            })}`;
  return (
    <Row
      testID="manager-session"
      title="This session"
      subtitle={text}
      right={
        <SettingsButton
          label="Clear"
          testID="manager-clear"
          disabled={session === null || session === undefined || session === 'error'}
          onPress={() => {
            api
              .rotateChat(SPECIAL_THREAD_IDS.manager, { carry: false })
              .then(load)
              .catch((e: Error) => Alert.alert('Could not clear the session', e.message));
          }}
        />
      }
    />
  );
}

/** Context → Start fresh after N messages, keeping half (spec/06 § Bounded context). */
function ContextWindowRow({ value }: { value: number }): React.ReactElement {
  const [draft, setDraft] = React.useState(String(value));
  React.useEffect(() => setDraft(String(value)), [value]);
  return (
    <Row
      testID="manager-context-window-row"
      title="Start fresh after"
      subtitle={`messages, keeping the last ${Math.max(1, Math.floor(value / 2))}`}
      right={
        <Field
          testID="manager-context-window"
          accessibilityLabel="Start a fresh session after (messages)"
          value={draft}
          onChangeText={setDraft}
          keyboardType="number-pad"
          style={{ width: 72, textAlign: 'center' }}
          onBlur={() => {
            const next = draft.trim();
            if (next === String(value)) return;
            if (!/^[1-9]\d*$/.test(next)) {
              Alert.alert('Invalid number', 'Start fresh after must be a whole number above 0.');
              setDraft(String(value));
              return;
            }
            writePreferences({ managerContextWindow: Number(next) });
          }}
        />
      }
    />
  );
}

// ── Voice ────────────────────────────────────────────────────────────────────

const DICTATION_LABELS: Record<DictationEngine, string> = {
  local: 'Parakeet (free, on device)',
  device: 'Built-in',
  deepgram: 'Deepgram',
  elevenlabs: 'ElevenLabs',
  host: 'Host server',
  whisper: 'Whisper',
};
const DICTATION_KIND_LABELS: Record<string, string> = {
  mobile: 'Phone',
  desktop: 'Desktop app',
  web: 'Browser',
};
const MEETING_ENGINES: readonly MeetingEngine[] = ['local', 'elevenlabs', 'deepgram', 'assemblyai'];
const MEETING_LABELS: Record<MeetingEngine, string> = {
  local: 'Parakeet (free, on device)',
  elevenlabs: 'ElevenLabs',
  deepgram: 'Deepgram',
  assemblyai: 'AssemblyAI',
};
const HOST_SPEECH_LABELS: Record<SpeechBackendSetting, string> = {
  auto: 'Automatic',
  off: 'Off',
  groq: 'Groq',
  elevenlabs: 'ElevenLabs',
  local: 'Local',
  parakeet: 'Parakeet',
};

export function DictationPage(): React.ReactElement {
  return (
    <SettingsPage title="Dictation" testID="settings-page-dictation">
      <SettingsSection title="Engine" testID="settings-voice-dictation-engines">
        <DictationEngines />
      </SettingsSection>
      <SettingsSection title="Host transcription" testID="settings-host-speech">
        <WithSettings testID="host-speech">
          {(data) => (
            <Row title="Hosts transcribe with" testID="host-speech-row" stack>
              <Chips
                options={SpeechBackendSetting.options}
                selected={data.preferences.speechBackend}
                testIDPrefix="host-speech"
                labelPrefix="Hosts transcribe with"
                labelOf={(b) => HOST_SPEECH_LABELS[b]}
                onSelect={(b) => void patchShared('Speech engine', { speechBackend: b })}
              />
            </Row>
          )}
        </WithSettings>
      </SettingsSection>
      <SettingsSection title="When to send" testID="settings-voice-dictation">
        <WithSettings testID="voice-dictation">
          {(data) => (
            <>
              <ToggleRow
                label="Detect when I've finished"
                testID="dictation-turn-detection"
                value={data.preferences.dictationTurnDetection}
                onChange={(next) =>
                  void patchShared('Turn detection', { dictationTurnDetection: next })
                }
              />
              <Row
                title={
                  data.preferences.dictationTurnDetection
                    ? 'Send anyway after a pause of'
                    : 'Send after a pause of'
                }
                testID="dictation-pause-row"
                stack
              >
                <Chips
                  options={DICTATION_PAUSE_CHOICES}
                  selected={String(data.preferences.dictationPauseSeconds) as DictationPauseChoice}
                  testIDPrefix="dictation-pause"
                  labelPrefix="Dictation pause"
                  labelOf={(c) => `${c}s`}
                  onSelect={(c) =>
                    void patchShared('Dictation pause', { dictationPauseSeconds: Number(c) })
                  }
                />
              </Row>
            </>
          )}
        </WithSettings>
      </SettingsSection>
    </SettingsPage>
  );
}

export function MeetingsPage(): React.ReactElement {
  return (
    <SettingsPage title="Meetings" testID="settings-page-meetings">
      <SettingsSection testID="settings-voice-meeting">
        <MeetingEngineRow />
      </SettingsSection>
      <WithSettings testID="meeting-settings">
        {(data) => (
          <>
            <SettingsSection title="Models and timing" testID="settings-meeting-models">
              <MeetingControls preferences={data.preferences} />
            </SettingsSection>
            <SettingsSection title="Prompts" testID="settings-meeting-prompts">
              <TextPromptLink layer="meeting-now" preferences={data.preferences} />
              <TextPromptLink layer="meeting-notes" preferences={data.preferences} />
              <TextPromptLink layer="meeting-actions" preferences={data.preferences} />
            </SettingsSection>
          </>
        )}
      </WithSettings>
    </SettingsPage>
  );
}

export function VoicePage(): React.ReactElement {
  return (
    <SettingsPage title="Voice" testID="settings-page-voice">
      <VoiceAgentSection />
      <AgentsCallingSection />
      <CallsSection />
      <VoiceUsage />
      <VoiceDevicesSection />
      <WithSettings testID="voice-device-prompt">
        {(data) => (
          <SettingsSection title="On a voice device" testID="settings-voice-device-prompt">
            <TextPromptLink layer="voice-device" preferences={data.preferences} />
          </SettingsSection>
        )}
      </WithSettings>
    </SettingsPage>
  );
}

const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-GB');

/** What voice has used across every host: tokens, ElevenLabs credits, and the plan. */
function VoiceUsage(): React.ReactElement | null {
  const hosts = usePresenceStore((s) => s.hosts);
  const usages = Object.values(hosts).flatMap((h) =>
    h.host?.voiceUsage ? [h.host.voiceUsage] : [],
  );
  if (usages.length === 0) return null;
  const sum = (f: (u: (typeof usages)[number]) => number | undefined): number =>
    usages.reduce((n, u) => n + (f(u) ?? 0), 0);
  const plan = usages.find((u) => u.elevenLabsPlan !== undefined)?.elevenLabsPlan;
  const line = (c: number, t: number, cr: number): string =>
    `${c} ${c === 1 ? 'call' : 'calls'} · ${fmtInt(t)} tokens · ${fmtInt(cr)} ElevenLabs credits`;
  return (
    <SettingsSection title="Usage" testID="voice-usage">
      <Row
        title="This month"
        testID="voice-usage-month"
        subtitle={line(
          sum((u) => u.monthCalls),
          sum((u) => u.monthTokens),
          sum((u) => u.monthCredits),
        )}
      />
      <Row
        title="In all"
        testID="voice-usage-all"
        subtitle={line(
          sum((u) => u.allCalls),
          sum((u) => u.allTokens),
          sum((u) => u.allCredits),
        )}
      />
      {plan ? (
        <Row
          title="ElevenLabs plan"
          testID="voice-usage-plan"
          subtitle={`${fmtInt(plan.used)} of ${fmtInt(plan.limit)} credits used`}
        />
      ) : null}
    </SettingsSection>
  );
}

/** Who transcribes a meeting; the paid engines are chosen deliberately. */
function MeetingEngineRow(): React.ReactElement {
  const colors = useTheme();
  const [busy, setBusy] = React.useState(false);
  const hosts = usePresenceStore((s) => s.hosts);
  const hostReports = Object.values(hosts).flatMap((h) =>
    h.host ? [{ hostName: h.host.hostName, voiceKeys: h.host.voiceKeys }] : [],
  );
  return (
    <WithSettings testID="voice-meeting-engine">
      {(data) => {
        const voiceConfig = data.preferences.voiceConfig;
        const status = voiceKeyHostStatus(voiceConfig.meeting, hostReports);
        return (
          <Row
            title="Transcription"
            testID="meeting-engine"
            subtitle={
              status ? (
                <Text
                  testID="meeting-engine-keys"
                  style={{ ...typography.meta, color: colors.red }}
                >
                  {status}
                </Text>
              ) : undefined
            }
            stack
          >
            <Chips
              options={MEETING_ENGINES}
              selected={voiceConfig.meeting}
              labelOf={(e) => MEETING_LABELS[e]}
              disabled={busy}
              testIDPrefix="meeting-engine"
              labelPrefix="Meeting transcription"
              onSelect={(meeting) => {
                setBusy(true);
                void useSettingsStore
                  .getState()
                  .updatePreferences({ voiceConfig: { ...voiceConfig, meeting } })
                  .catch((e: Error) => Alert.alert('Settings failed', e.message))
                  .finally(() => setBusy(false));
              }}
            />
          </Row>
        );
      }}
    </WithSettings>
  );
}

/**
 * Where dictation's words come from (spec/07 § Dictation engines): every
 * signed-in device picks its own engine, all listed at once; and whether
 * Whisper tidies up a live engine's words as dictation goes on.
 */
function DictationEngines(): React.ReactElement {
  const colors = useTheme();
  const [busy, setBusy] = React.useState(false);
  const hosts = usePresenceStore((s) => s.hosts);
  const hostReports = Object.values(hosts).flatMap((h) =>
    h.host ? [{ hostName: h.host.hostName, voiceKeys: h.host.voiceKeys }] : [],
  );
  return (
    <WithSettings testID="voice-dictation-engines">
      {(data) => {
        const voiceConfig = data.preferences.voiceConfig;
        const dictation = voiceConfig.dictation;
        const own = data.preferences.deviceDictation ?? {};
        const devices = data.devices.filter((d) => d.surfaceKind in DICTATION_KIND_LABELS);
        const keys = (engine: DictationEngine, testID: string): React.ReactNode => {
          const status = voiceKeyHostStatus(engine, hostReports);
          return status ? (
            <Text testID={testID} style={{ ...typography.meta, color: colors.red }}>
              {status}
            </Text>
          ) : undefined;
        };
        return (
          <>
            <Row title="Speech to text" testID="stt-row" stack>
              <Chips
                options={SpeechToTextEngine.options}
                selected={voiceConfig.speechToText}
                labelOf={(e) => SPEECH_TO_TEXT_LABEL[e]}
                disabled={busy}
                testIDPrefix="stt-engine"
                labelPrefix="Speech to text"
                onSelect={(speechToText) => {
                  setBusy(true);
                  void useSettingsStore
                    .getState()
                    .updatePreferences({ voiceConfig: { ...voiceConfig, speechToText } })
                    .catch((e: Error) => Alert.alert('Settings failed', e.message))
                    .finally(() => setBusy(false));
                }}
              />
            </Row>
            {devices.map((d) => {
              const kind = d.surfaceKind as AudioSurfaceKind;
              const engine =
                own[d.surfaceId] ?? (kind === 'mobile' ? dictation.phone : dictation.computer);
              return (
                <Row
                  key={d.surfaceId}
                  title={d.label}
                  testID={`dictation-device-${d.surfaceId}`}
                  subtitle={
                    <View style={{ gap: space.xs }}>
                      <Muted>
                        {d.isCurrent ? 'This device' : DICTATION_KIND_LABELS[d.surfaceKind]}
                      </Muted>
                      {keys(engine, `dictation-${d.surfaceId}-keys`)}
                    </View>
                  }
                  stack
                >
                  <Chips
                    options={dictationEnginesFor(kind)}
                    selected={engine}
                    labelOf={(e) => DICTATION_LABELS[e]}
                    disabled={busy}
                    testIDPrefix={`dictation-device-${d.surfaceId}`}
                    labelPrefix={`${d.label} dictation`}
                    onSelect={(next) => {
                      setBusy(true);
                      void patchShared('Dictation', {
                        deviceDictation: { ...own, [d.surfaceId]: next },
                      }).finally(() => setBusy(false));
                    }}
                  />
                </Row>
              );
            })}
            <ToggleRow
              label={`Tidy up each phrase with ${SPEECH_TO_TEXT_LABEL[voiceConfig.speechToText]}`}
              testID="dictation-tidy"
              value={dictation.tidy}
              disabled={busy}
              onChange={(tidy) => {
                setBusy(true);
                void useSettingsStore
                  .getState()
                  .updatePreferences({
                    voiceConfig: { ...voiceConfig, dictation: { ...dictation, tidy } },
                  })
                  .catch((e: Error) => Alert.alert('Settings failed', e.message))
                  .finally(() => setBusy(false));
              }}
            />
          </>
        );
      }}
    </WithSettings>
  );
}
