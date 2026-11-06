// Settings → Prompts: every prompt Patch sends to an agent in one list, each
// marked Default or Custom, opening the full-screen editor (LayerEditor, whose
// Reset to default is the way back).

import React from 'react';
import { useRouter } from 'expo-router';
import { SettingsSection } from '../SettingsSection';
import { usePresenceStore } from '../../stores/presenceStore';
import { LAYER_TITLE, MEETING_PROMPTS, TEXT_PROMPTS, type Layer } from './AgentBehaviorSection';
import { SettingsPage } from './SettingsPage';
import { ModelChoice } from './ModelChoice';
import { writePreferences } from './PreferenceSections';
import { Field, Muted, Row, SettingsButton, WithSettings } from './ui';
import type { AccountPreferences } from '../../api/rest';

function CheckInInterval({ preferences }: { preferences: AccountPreferences }): React.ReactElement {
  const [minutes, setMinutes] = React.useState(String(preferences.watchCheckInMinutes));
  React.useEffect(
    () => setMinutes(String(preferences.watchCheckInMinutes)),
    [preferences.watchCheckInMinutes],
  );
  return (
    <Row
      title="Background task check-in every"
      right={
        <>
          <Field
            testID="watch-check-in-minutes"
            accessibilityLabel="Minutes between background task check-ins"
            value={minutes}
            onChangeText={setMinutes}
            keyboardType="number-pad"
            style={{ width: 56, textAlign: 'center' }}
            onBlur={() => {
              const next = Number(minutes.trim());
              if (!Number.isInteger(next) || next < 1) {
                setMinutes(String(preferences.watchCheckInMinutes));
                return;
              }
              if (next !== preferences.watchCheckInMinutes)
                writePreferences({ watchCheckInMinutes: next });
            }}
          />
          <Muted>minutes</Muted>
        </>
      }
    />
  );
}

export function PromptsPage(): React.ReactElement {
  const router = useRouter();
  const toolsDefault = usePresenceStore(
    (s) =>
      Object.values(s.hosts).find((h) => h.host?.harnessToolsPromptDefault !== undefined)?.host
        ?.harnessToolsPromptDefault ?? '',
  );
  const row = (layer: Layer, custom: boolean): React.ReactElement => (
    <Row
      key={layer}
      title={LAYER_TITLE[layer]}
      subtitle={custom ? 'Custom' : 'Default'}
      subtitleTestID={`prompt-${layer}-state`}
      right={
        <SettingsButton
          testID={`prompt-${layer}-edit`}
          label="Edit"
          variant="quiet"
          onPress={() => router.push({ pathname: '/settings/layer', params: { layer } })}
        />
      }
    />
  );
  return (
    <SettingsPage title="Prompts" testID="settings-page-prompts">
      <WithSettings testID="prompts">
        {(data) => {
          const p = data.preferences;
          const toolsCustom =
            p.harnessToolsPrompt !== null &&
            (toolsDefault === '' || p.harnessToolsPrompt !== toolsDefault);
          return (
            <>
              <SettingsSection testID="settings-prompts">
                <CheckInInterval preferences={p} />
                {(Object.keys(TEXT_PROMPTS) as (keyof typeof TEXT_PROMPTS)[])
                  .filter((layer) => !(MEETING_PROMPTS as readonly string[]).includes(layer))
                  .map((layer) =>
                    row(layer, p[TEXT_PROMPTS[layer].key] !== TEXT_PROMPTS[layer].fallback),
                  )}
                {row('tools', toolsCustom)}
                {row('system', p.harnessSystemPrompt !== '')}
              </SettingsSection>
              <SettingsSection title="Meetings" testID="settings-prompts-meetings">
                <MeetingControls preferences={p} />
                {MEETING_PROMPTS.map((layer) =>
                  row(layer, p[TEXT_PROMPTS[layer].key] !== TEXT_PROMPTS[layer].fallback),
                )}
              </SettingsSection>
            </>
          );
        }}
      </WithSettings>
    </SettingsPage>
  );
}

/** The meeting models and how often the notes are refreshed, saved on blur like the other fields. */
function MeetingControls({ preferences }: { preferences: AccountPreferences }): React.ReactElement {
  const [seconds, setSeconds] = React.useState(String(preferences.meetingAnalyseSeconds));
  const [stt, setStt] = React.useState(preferences.meetingTranscriptionModel);
  React.useEffect(
    () => setSeconds(String(preferences.meetingAnalyseSeconds)),
    [preferences.meetingAnalyseSeconds],
  );
  React.useEffect(
    () => setStt(preferences.meetingTranscriptionModel),
    [preferences.meetingTranscriptionModel],
  );
  return (
    <>
      <ModelChoice
        label="Analysis model"
        testID="meeting-analysis-model"
        value={preferences.meetingAnalysisModel}
        onSelect={(id) => writePreferences({ meetingAnalysisModel: id })}
      />
      <ModelChoice
        label="Clean-up model"
        testID="meeting-cleanup-model"
        value={preferences.meetingCleanupModel}
        onSelect={(id) => writePreferences({ meetingCleanupModel: id })}
      />
      <Row
        title="Transcription model"
        subtitle="Model directory (local) or Groq model name; empty is the host's"
        right={
          <Field
            testID="meeting-transcription-model"
            accessibilityLabel="Meeting transcription model"
            value={stt}
            placeholder="Host default"
            onChangeText={setStt}
            style={{ width: 160 }}
            onBlur={() => {
              const next = stt.trim();
              if (next !== preferences.meetingTranscriptionModel)
                writePreferences({ meetingTranscriptionModel: next });
            }}
          />
        }
      />
      <Row
        title="Analyse every"
        right={
          <>
            <Field
              testID="meeting-analyse-seconds"
              accessibilityLabel="Seconds between meeting analysis passes at Normal speed"
              value={seconds}
              onChangeText={setSeconds}
              keyboardType="number-pad"
              style={{ width: 56, textAlign: 'center' }}
              onBlur={() => {
                const next = Number(seconds.trim());
                if (!Number.isInteger(next) || next < 5 || next > 300) {
                  setSeconds(String(preferences.meetingAnalyseSeconds));
                  return;
                }
                if (next !== preferences.meetingAnalyseSeconds)
                  writePreferences({ meetingAnalyseSeconds: next });
              }}
            />
            <Muted>seconds (5–300)</Muted>
          </>
        }
      />
    </>
  );
}
