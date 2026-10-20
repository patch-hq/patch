// Settings → Prompts: every prompt Patch sends to an agent in one list, each
// marked Default or Custom, opening the full-screen editor (LayerEditor, whose
// Reset to default is the way back).

import React from 'react';
import { useRouter } from 'expo-router';
import { SettingsSection } from '../SettingsSection';
import { usePresenceStore } from '../../stores/presenceStore';
import { LAYER_TITLE, TEXT_PROMPTS, type Layer } from './AgentBehaviorSection';
import { SettingsPage } from './SettingsPage';
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
            <SettingsSection title="Prompts" testID="settings-prompts">
              <CheckInInterval preferences={p} />
              {(Object.keys(TEXT_PROMPTS) as (keyof typeof TEXT_PROMPTS)[]).map((layer) =>
                row(layer, p[TEXT_PROMPTS[layer].key] !== TEXT_PROMPTS[layer].fallback),
              )}
              {row('tools', toolsCustom)}
              {row('system', p.harnessSystemPrompt !== '')}
            </SettingsSection>
          );
        }}
      </WithSettings>
    </SettingsPage>
  );
}
