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
// Voice — one config for every voice conversation (calls, hands-free, voice
// devices): provider, model, voice and hand-off; Local nests what reads the
// replies out. Then what voice has used, and voice devices.

import React from 'react';
import { Alert, Text, View } from 'react-native';
import type { AccountPreferences, VoiceBackend, VoiceHandoff, VoiceLayer } from '../../api/rest';
import { space, typography, useTheme } from '../../lib/theme';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePresenceStore } from '../../stores/presenceStore';
import {
  SPEECH_TO_TEXT_LABEL,
  SpeechToTextEngine,
  GEMINI_VOICES,
  OPENAI_VOICES,
  dictationEnginesFor,
  voiceKeyHostStatus,
  type AudioSurfaceKind,
  type DictationEngine,
  type MeetingEngine,
} from '@patch/wire/audio';
import { DICTATION_PAUSE_CHOICES } from '@patch/wire';
type DictationPauseChoice = (typeof DICTATION_PAUSE_CHOICES)[number];
import { OptionPicker } from '../OptionPicker';
import { SettingsSection } from '../SettingsSection';
import { VoiceDevicesSection } from './DevicesSections';
import { patchShared } from './sharedWrite';
import { ModelChoice } from './ModelChoice';
import { ManagerHomeSection } from './ManagerHomeSection';
import { SettingsPage } from './SettingsPage';
import { MeetingControls, TextPromptLink } from './PromptRows';
import { Chips, Field, Muted, Row, ToggleRow, WithSettings } from './ui';

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
              <TextPromptLink layer="manager-voice" preferences={data.preferences} />
              <TextPromptLink layer="sweep" preferences={data.preferences} />
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
      <ToggleRow
        label="Enabled"
        testID="manager-watching"
        value={preferences.sweepEnabled}
        onChange={(next) => writePreferences({ sweepEnabled: next })}
      />
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

// ── Voice ────────────────────────────────────────────────────────────────────

const VOICE_BACKENDS: readonly VoiceBackend[] = ['local', 'gemini', 'openai', 'elevenlabs'];
const VOICE_BACKEND_LABELS: Record<VoiceBackend, string> = {
  local: 'Local',
  gemini: 'Gemini',
  openai: 'OpenAI',
  elevenlabs: 'ElevenLabs',
};
type Variant = Exclude<VoiceLayer, 'direct'>;
const VARIANTS: readonly Variant[] = ['light', 'heavy'];
const VARIANT_NAMES: Record<Exclude<VoiceBackend, 'local'>, Record<Variant, string>> = {
  gemini: { light: 'Flash', heavy: 'Thinking' },
  openai: { light: 'mini', heavy: 'full' },
  elevenlabs: { light: 'Haiku', heavy: 'Sonnet' },
};
const variantOf = (layer: VoiceLayer): Variant => (layer === 'heavy' ? 'heavy' : 'light');
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
/** The three conversation entries share one config; `call` is the one shown. */
const VOICE_SURFACES = ['call', 'handsFree', 'device'] as const;

/**
 * What actually happens for a config, right now. Mirrors the host's audio
 * server branching and web's `voiceCellStatus`, so neither surface claims a
 * config works when the host would refuse it.
 */
export function voiceCellStatus(backend: VoiceBackend, layer?: VoiceLayer): string | null {
  if (backend === 'local' && layer !== undefined && layer !== 'direct') {
    return 'Not implemented yet — no front model built for local. Refused at connect time.';
  }
  return null;
}

export function DictationPage(): React.ReactElement {
  return (
    <SettingsPage title="Dictation" testID="settings-page-dictation">
      <SettingsSection title="Engine" testID="settings-voice-dictation-engines">
        <DictationEngines />
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
      <SettingsSection title="Engine" testID="settings-voice-config">
        <VoiceEngine />
      </SettingsSection>
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

/**
 * The voice conversation config (spec/07 § Voice). One choice drives calls,
 * hands-free and voice devices: it is written to all three cells.
 */
function VoiceEngine(): React.ReactElement {
  const colors = useTheme();
  const [busy, setBusy] = React.useState(false);
  const hosts = usePresenceStore((s) => s.hosts);
  const hostReports = Object.values(hosts).flatMap((h) =>
    h.host ? [{ hostName: h.host.hostName, voiceKeys: h.host.voiceKeys }] : [],
  );
  return (
    <WithSettings testID="voice-config">
      {(data) => {
        const prefs = data.preferences;
        const voiceConfig = prefs.voiceConfig;
        const cell = voiceConfig.call;
        const { backend, layer, handoff } = cell;
        const write = (next: {
          backend: VoiceBackend;
          layer: VoiceLayer;
          handoff: VoiceHandoff;
        }): void => {
          setBusy(true);
          const all = Object.fromEntries(VOICE_SURFACES.map((k) => [k, next]));
          void useSettingsStore
            .getState()
            .updatePreferences({ voiceConfig: { ...voiceConfig, ...all } })
            .catch((e: Error) => Alert.alert('Settings failed', e.message))
            .finally(() => setBusy(false));
        };
        const status = voiceCellStatus(backend, layer);
        const keyStatus = voiceKeyHostStatus(backend, hostReports);
        return (
          <>
            <Row
              title="Provider"
              testID="voice-provider"
              subtitle={
                status || keyStatus ? (
                  <View style={{ gap: space.xs }}>
                    {status ? <Muted testID="voice-status">{status}</Muted> : null}
                    {keyStatus ? (
                      <Text testID="voice-keys" style={{ ...typography.meta, color: colors.red }}>
                        {keyStatus}
                      </Text>
                    ) : null}
                  </View>
                ) : undefined
              }
              stack
            >
              <Chips
                options={VOICE_BACKENDS}
                selected={backend}
                labelOf={(b) => VOICE_BACKEND_LABELS[b]}
                disabled={busy}
                testIDPrefix="voice-engine"
                labelPrefix="Voice provider"
                onSelect={(b) =>
                  write({
                    backend: b,
                    layer: b === 'local' ? 'direct' : variantOf(layer),
                    handoff: handoff === 'never' ? 'never' : 'auto',
                  })
                }
              />
            </Row>
            {backend === 'local' ? (
              <LocalCallRows preferences={prefs} />
            ) : (
              <>
                <Row title="Model" testID="voice-model" stack>
                  <Chips
                    options={VARIANTS}
                    selected={variantOf(layer)}
                    labelOf={(v) => VARIANT_NAMES[backend][v]}
                    disabled={busy}
                    testIDPrefix="voice-variant"
                    labelPrefix="Voice model"
                    onSelect={(v) => write({ ...cell, layer: v })}
                  />
                </Row>
                <HostedVoiceRow backend={backend} preferences={prefs} />
                <ToggleRow
                  label="Pass work to the chat’s agent"
                  subtitle={
                    handoff === 'never'
                      ? 'The voice answers everything itself.'
                      : 'The voice answers what it can and hands the rest to the agent.'
                  }
                  testID="voice-handoff"
                  value={handoff !== 'never'}
                  disabled={busy}
                  onChange={(on) => write({ ...cell, handoff: on ? 'auto' : 'never' })}
                />
              </>
            )}
          </>
        );
      }}
    </WithSettings>
  );
}

/** The voice a hosted provider speaks in. */
function HostedVoiceRow({
  backend,
  preferences,
}: {
  backend: Exclude<VoiceBackend, 'local'>;
  preferences: AccountPreferences;
}): React.ReactElement {
  if (backend === 'elevenlabs') return <ElevenLabsVoiceRow preferences={preferences} />;
  const key = backend === 'gemini' ? 'geminiVoice' : 'openaiVoice';
  const value = preferences[key];
  const voices = (backend === 'gemini' ? GEMINI_VOICES : OPENAI_VOICES).map((v) => ({
    id: v,
    label: v,
  }));
  return (
    <Row
      title="Voice"
      testID={`voice-${backend}-voice-row`}
      right={
        <OptionPicker
          testID={`voice-${backend}-voice`}
          selectedId={value ?? ''}
          selectedLabel={value ?? 'Provider default'}
          options={voices}
          onSelect={(id) => void patchShared('Voice', { [key]: id })}
          emptyText="No voices"
        />
      }
    />
  );
}

/** The account's ElevenLabs voices, listed by whichever online host holds the key. */
function ElevenLabsVoiceRow({
  preferences,
}: {
  preferences: AccountPreferences;
}): React.ReactElement {
  const hosts = usePresenceStore((s) => s.hosts);
  const reports = Object.values(hosts).flatMap((h) => (h.host ? [h.host] : []));
  const voices = reports.find((h) => h.elevenLabsVoices !== undefined)?.elevenLabsVoices;
  const error = reports.find((h) => h.elevenLabsVoicesError !== undefined)?.elevenLabsVoicesError;
  const current = preferences.elevenLabsVoice;
  const options = (voices ?? []).map((v) => ({
    id: v.id,
    label:
      v.category === 'generated'
        ? `${v.name} (designed)`
        : v.category && v.category !== 'premade'
          ? `${v.name} (${v.category})`
          : v.name,
  }));
  return (
    <Row
      title="Voice"
      testID="voice-elevenlabs-voice-row"
      subtitle={
        error !== undefined
          ? `Could not list ElevenLabs voices: ${error}`
          : voices === undefined
            ? 'Add an ElevenLabs key under Hosts → Keys to list voices'
            : undefined
      }
      right={
        <OptionPicker
          testID="elevenlabs-voice"
          selectedId={current ?? ''}
          selectedLabel={
            current === undefined ? '—' : (options.find((o) => o.id === current)?.label ?? current)
          }
          options={options}
          disabled={voices === undefined}
          onSelect={(id) => void patchShared('Voice', { elevenLabsVoice: id })}
          emptyText="No voices"
        />
      }
    />
  );
}

/**
 * Standard Kokoro v1 voices — the same list web offers. Names match the `.pt`
 * files the sidecar loads by name.
 */
export const KOKORO_VOICES: { id: string; label: string }[] = [
  { id: 'af_heart', label: 'Heart (American F)' },
  { id: 'af_bella', label: 'Bella (American F)' },
  { id: 'af_sky', label: 'Sky (American F)' },
  { id: 'af_sarah', label: 'Sarah (American F)' },
  { id: 'af_nicole', label: 'Nicole (American F)' },
  { id: 'am_adam', label: 'Adam (American M)' },
  { id: 'am_michael', label: 'Michael (American M)' },
  { id: 'bf_emma', label: 'Emma (British F)' },
  { id: 'bf_isabella', label: 'Isabella (British F)' },
  { id: 'bm_george', label: 'George (British M)' },
  { id: 'bm_lewis', label: 'Lewis (British M)' },
];

/**
 * Local calls: words are transcribed on the host, every turn goes to the
 * chat's agent, and its reply is read out by Kokoro or ElevenLabs.
 */
function LocalCallRows({ preferences }: { preferences: AccountPreferences }): React.ReactElement {
  const tts = preferences.ttsBackend ?? 'kokoro';
  const currentVoice = preferences.kokoroVoice;
  return (
    <>
      <Row
        title="Read replies with"
        subtitle="Every turn goes to the chat’s agent; its reply is read out."
        testID="voice-local-tts"
        stack
      >
        <Chips
          options={['kokoro', 'elevenlabs'] as const}
          selected={tts}
          labelOf={(t) => (t === 'kokoro' ? 'Kokoro (free)' : 'ElevenLabs')}
          testIDPrefix="tts-backend"
          labelPrefix="Speech engine"
          onSelect={(t) => void patchShared('Speech engine', { ttsBackend: t })}
        />
      </Row>
      {tts === 'elevenlabs' ? (
        <ElevenLabsVoiceRow preferences={preferences} />
      ) : (
        <Row
          title="Voice"
          testID="voice-settings"
          subtitle={currentVoice === undefined ? 'Each host’s Kokoro default' : undefined}
          right={
            <OptionPicker
              testID="kokoro-voice"
              selectedId={currentVoice ?? ''}
              selectedLabel={
                currentVoice === undefined
                  ? '—'
                  : (KOKORO_VOICES.find((v) => v.id === currentVoice)?.label ?? currentVoice)
              }
              options={KOKORO_VOICES}
              onSelect={(id) => void patchShared('Voice', { kokoroVoice: id })}
              emptyText="No voices"
            />
          }
        />
      )}
    </>
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
