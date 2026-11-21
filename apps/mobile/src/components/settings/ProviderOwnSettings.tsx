// Settings → Providers: each provider's own settings (spec/10 § Provider
// settings; decision 9), the same groups the web Settings shows: every
// provider's from the table, then each ACP agent's that declares some. The
// value shown is the user's choice, else what a host's own configuration holds
// (where hosts report it), else the provider's default, and the row says which.
// Saving writes the choice to the server; hosts write it into the provider's
// own configuration.

import React from 'react';
import { View } from 'react-native';
import {
  PROVIDERS as WIRE_PROVIDERS,
  ownSettingsGroups,
  type OwnSettingsGroup,
  type ProviderDescriptor,
  type ProviderSettingDescriptor,
} from '@patch/wire';
import { space } from '../../lib/theme';
import { usePresenceStore } from '../../stores/presenceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { SettingsSection } from '../SettingsSection';
import { hostName, sortedHosts } from './HostSwitcher';
import { patchShared } from './sharedWrite';
import { ButtonRow, Field, Muted, Row, SettingsButton, ToggleRow } from './ui';

export function ProviderOwnSettings(): React.ReactElement {
  const acpAgents = useSettingsStore((s) => s.data?.preferences.acpAgents);
  return (
    <>
      {ownSettingsGroups(acpAgents).map((g) => (
        <SettingsSection
          key={g.id}
          title={`${g.label} settings`}
          testID={`provider-settings-${g.id}`}
        >
          {g.settings.map((setting) => (
            <ProviderSettingRow key={setting.key} group={g} setting={setting} />
          ))}
          {g.note !== undefined ? (
            <View style={{ paddingHorizontal: space.md, paddingVertical: space.sm }}>
              <Muted testID={`provider-settings-note-${g.id}`}>{g.note}</Muted>
            </View>
          ) : null}
        </SettingsSection>
      ))}
    </>
  );
}

/** A dotted path's number in a JSON document, or undefined. */
function numberAt(doc: unknown, key: string): number | undefined {
  let at = doc;
  for (const part of key.split('.')) {
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return typeof at === 'number' ? at : undefined;
}

function ProviderSettingRow({
  group,
  setting,
}: {
  group: OwnSettingsGroup;
  setting: ProviderSettingDescriptor;
}): React.ReactElement {
  const conn = usePresenceStore((s) => s.connection);
  const hosts = usePresenceStore((s) => s.hosts);
  const preferences = useSettingsStore((s) => s.data?.preferences ?? null);
  const chosen = preferences?.providerSettings[group.id]?.[setting.key];
  const reportedByHost = (WIRE_PROVIDERS as readonly ProviderDescriptor[]).some(
    (p) => p.id === group.id && p.ownSettingsReportedByHost,
  );
  let value: number | null = setting.providerDefault;
  let source = `${group.label}’s own default`;
  let problem: string | null = null;
  if (chosen !== undefined) {
    value = chosen;
    source = 'Chosen here';
  } else if (reportedByHost) {
    // The provider's own configuration file, as the hosts report it.
    for (const h of sortedHosts(hosts)) {
      const text = h.claudeSettings?.settingsJson ?? '';
      if (text.trim() === '') continue;
      try {
        const own = numberAt(JSON.parse(text), setting.key);
        if (own !== undefined) {
          value = own;
          source = `Set in ${hostName(h)}’s own settings.json`;
          break;
        }
      } catch {
        problem = `${hostName(h)}’s settings.json is not valid JSON, so its value cannot be shown.`;
      }
    }
  }
  const save = (n: number): void => {
    if (preferences === null) return;
    void patchShared(setting.label, {
      providerSettings: {
        ...preferences.providerSettings,
        [group.id]: { ...preferences.providerSettings[group.id], [setting.key]: n },
      },
    });
  };
  const id = `provider-setting-${group.id}-${setting.key}`;
  const subtitle = problem ?? `${source}. ${setting.description}`;
  const [draft, setDraft] = React.useState(value === null ? '' : String(value));
  React.useEffect(() => setDraft(value === null ? '' : String(value)), [value]);
  if (setting.kind === 'toggle') {
    return (
      <ToggleRow
        testID={`${id}-input`}
        label={setting.label}
        subtitle={subtitle}
        value={value === 1}
        disabled={conn !== 'connected' || preferences === null}
        onChange={(on) => save(on ? 1 : 0)}
      />
    );
  }
  const n = Number(draft.trim());
  const valid = draft.trim() !== '' && Number.isInteger(n) && n >= setting.min && n <= setting.max;
  return (
    <Row
      testID={id}
      title={`${setting.label} (${setting.kind === 'days' ? 'days' : 'MB'})`}
      subtitle={subtitle}
    >
      <View style={{ marginTop: space.sm }}>
        <Field
          testID={`${id}-input`}
          accessibilityLabel={`${group.label}: ${setting.label}`}
          value={draft}
          placeholder={value === null ? 'No limit' : undefined}
          onChangeText={setDraft}
          keyboardType="number-pad"
          editable={preferences !== null}
        />
        <ButtonRow>
          <SettingsButton
            testID={`${id}-save`}
            label="Save"
            disabled={conn !== 'connected' || preferences === null || !valid || n === value}
            onPress={() => save(n)}
          />
        </ButtonRow>
      </View>
    </Row>
  );
}
