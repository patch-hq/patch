// Settings → Providers: each provider's own settings (spec/10 § Settings), the
// same group the web Settings shows. The value shown is the user's choice,
// else what a host's own configuration holds, else the provider's default, and
// the row says which. Saving writes the choice to the server; hosts write it
// into the provider's configuration.

import React from 'react';
import { View } from 'react-native';
import {
  PROVIDERS as WIRE_PROVIDERS,
  providerDescriptor,
  type ProviderDescriptor,
  type ProviderSettingDescriptor,
} from '@patch/wire';
import { space } from '../../lib/theme';
import { usePresenceStore } from '../../stores/presenceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { SettingsSection } from '../SettingsSection';
import { hostName, sortedHosts } from './HostSwitcher';
import { patchShared } from './sharedWrite';
import { ButtonRow, Field, Muted, Row, SettingsButton } from './ui';

export function ProviderOwnSettings(): React.ReactElement {
  return (
    <>
      {(WIRE_PROVIDERS as readonly ProviderDescriptor[])
        .filter((p) => p.settings.length > 0 || p.settingsNote !== undefined)
        .map((p) => (
          <SettingsSection
            key={p.id}
            title={`${p.label} settings`}
            testID={`provider-settings-${p.id}`}
          >
            {p.settings.map((setting) => (
              <ProviderSettingRow key={setting.key} providerId={p.id} setting={setting} />
            ))}
            {p.settingsNote !== undefined ? (
              <View style={{ paddingHorizontal: space.md, paddingVertical: space.sm }}>
                <Muted testID={`provider-settings-note-${p.id}`}>{p.settingsNote}</Muted>
              </View>
            ) : null}
          </SettingsSection>
        ))}
    </>
  );
}

function ProviderSettingRow({
  providerId,
  setting,
}: {
  providerId: string;
  setting: ProviderSettingDescriptor;
}): React.ReactElement {
  const conn = usePresenceStore((s) => s.connection);
  const hosts = usePresenceStore((s) => s.hosts);
  const preferences = useSettingsStore((s) => s.data?.preferences ?? null);
  const chosen = preferences?.providerSettings[providerId]?.[setting.key];
  let value = setting.providerDefault;
  let source = `${providerDescriptor(providerId).label}’s own default`;
  let problem: string | null = null;
  if (chosen !== undefined) {
    value = chosen;
    source = 'Chosen here';
  } else if (providerId === 'claude') {
    for (const h of sortedHosts(hosts)) {
      const text = h.claudeSettings?.settingsJson ?? '';
      if (text.trim() === '') continue;
      try {
        const own = (JSON.parse(text) as Record<string, unknown>)[setting.key];
        if (typeof own === 'number') {
          value = own;
          source = `Set in ${hostName(h)}’s own settings.json`;
          break;
        }
      } catch {
        problem = `${hostName(h)}’s settings.json is not valid JSON, so its value cannot be shown.`;
      }
    }
  }
  const [draft, setDraft] = React.useState(String(value));
  React.useEffect(() => setDraft(String(value)), [value]);
  const n = Number(draft.trim());
  const valid = draft.trim() !== '' && Number.isInteger(n) && n >= setting.min && n <= setting.max;
  const save = (): void => {
    if (preferences === null) return;
    void patchShared(setting.label, {
      providerSettings: {
        ...preferences.providerSettings,
        [providerId]: { ...preferences.providerSettings[providerId], [setting.key]: n },
      },
    });
  };
  return (
    <Row
      testID={`provider-setting-${providerId}-${setting.key}`}
      title={`${setting.label} (days)`}
      subtitle={problem ?? `${source}. ${setting.description}`}
    >
      <View style={{ marginTop: space.sm }}>
        <Field
          testID={`provider-setting-${providerId}-${setting.key}-input`}
          accessibilityLabel={`${providerDescriptor(providerId).label}: ${setting.label}`}
          value={draft}
          onChangeText={setDraft}
          keyboardType="number-pad"
          editable={preferences !== null}
        />
        <ButtonRow>
          <SettingsButton
            testID={`provider-setting-${providerId}-${setting.key}-save`}
            label="Save"
            disabled={conn !== 'connected' || preferences === null || !valid || n === value}
            onPress={save}
          />
        </ButtonRow>
      </View>
    </Row>
  );
}
