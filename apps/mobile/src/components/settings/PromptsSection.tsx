// Settings → Prompts: every prompt Patch sends to an agent in one list, each
// marked Default or Custom, opening the full-screen editor (LayerEditor, whose
// Reset to default is the way back).

import React from 'react';
import { useRouter } from 'expo-router';
import { SettingsSection } from '../SettingsSection';
import { usePresenceStore } from '../../stores/presenceStore';
import { LAYER_TITLE, TEXT_PROMPTS, type Layer } from './AgentBehaviorSection';
import { SettingsPage } from './SettingsPage';
import { Row, SettingsButton, WithSettings } from './ui';

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
