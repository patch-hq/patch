// The prompt rows every Settings page uses, and the check-in and meeting
// controls that sit beside their prompts. Every prompt lives on the page for
// the feature it drives (spec/14 § `/settings` details).

import React from 'react';
import { useRouter } from 'expo-router';
import { LAYER_TITLE, TEXT_PROMPTS, type Layer } from './AgentBehaviorSection';
import { ModelChoice } from './ModelChoice';
import { writePreferences } from './PreferenceSections';
import { Field, Muted, Row, SettingsButton } from './ui';
import type { AccountPreferences } from '../../api/rest';

export function CheckInInterval({
  preferences,
}: {
  preferences: AccountPreferences;
}): React.ReactElement {
  const [minutes, setMinutes] = React.useState(String(preferences.watchCheckInMinutes));
  React.useEffect(
    () => setMinutes(String(preferences.watchCheckInMinutes)),
    [preferences.watchCheckInMinutes],
  );
  return (
    <Row
      title="Check in every"
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

/** One prompt: its title, whether it is the Default or a Custom version, and Edit (full screen). */
export function PromptLink({
  layer,
  custom,
}: {
  layer: Layer;
  custom: boolean;
}): React.ReactElement {
  const router = useRouter();
  return (
    <Row
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
}

/** A plain-text prompt's row, Default or Custom against its built-in text. */
export function TextPromptLink({
  layer,
  preferences,
}: {
  layer: keyof typeof TEXT_PROMPTS;
  preferences: AccountPreferences;
}): React.ReactElement {
  const { key, fallback } = TEXT_PROMPTS[layer];
  return <PromptLink layer={layer} custom={preferences[key] !== fallback} />;
}

/** The meeting models and how often the notes are refreshed, saved on blur like the other fields. */
export function MeetingControls({
  preferences,
}: {
  preferences: AccountPreferences;
}): React.ReactElement {
  const [seconds, setSeconds] = React.useState(String(preferences.meetingAnalyseSeconds));
  React.useEffect(
    () => setSeconds(String(preferences.meetingAnalyseSeconds)),
    [preferences.meetingAnalyseSeconds],
  );
  return (
    <>
      <ModelChoice
        label="Analysis"
        testID="meeting-analysis-model"
        value={preferences.meetingAnalysisModel}
        onSelect={(id) => writePreferences({ meetingAnalysisModel: id })}
      />
      <ModelChoice
        label="Clean-up"
        testID="meeting-cleanup-model"
        value={preferences.meetingCleanupModel}
        onSelect={(id) => writePreferences({ meetingCleanupModel: id })}
      />
      <Row
        title="Update notes every"
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
            <Muted>seconds</Muted>
          </>
        }
      />
    </>
  );
}
