// Settings → Chats: what patch does to a chat on its own — naming it, and
// summarising where it has got to after each turn. Neither is about an
// account or a limit, so neither is on Usage. Shared settings (spec/01 § Settings).

import React from 'react';
import { Alert } from 'react-native';
import { SettingsSection } from '../SettingsSection';
import { SettingsPage } from './SettingsPage';
import { patchShared } from './sharedWrite';
import { Field, Row, ToggleRow, WithSettings } from './ui';

/** An hour of the day (0–23) that commits on blur; anything else is refused and the field reverts. */
function HourField({
  value,
  testID,
  label,
  onCommit,
}: {
  value: number;
  testID: string;
  label: string;
  onCommit: (next: number) => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState(String(value));
  React.useEffect(() => setDraft(String(value)), [value]);
  return (
    <Field
      testID={testID}
      accessibilityLabel={label}
      value={draft}
      onChangeText={setDraft}
      keyboardType="number-pad"
      style={{ width: 72, textAlign: 'center' }}
      onBlur={() => {
        const next = draft.trim();
        if (next === String(value)) return;
        if (!/^([01]?\d|2[0-3])$/.test(next)) {
          Alert.alert('Invalid hour', `${label} must be a whole hour from 0 to 23.`);
          setDraft(String(value));
          return;
        }
        onCommit(Number(next));
      }}
    />
  );
}

export function ChatsPage(): React.ReactElement {
  return (
    <SettingsPage title="Chats" testID="settings-page-chats">
      <WithSettings testID="chats">
        {(data) => (
          <SettingsSection testID="settings-chats">
            <ToggleRow
              label="Generate chat titles"
              testID="title-generation"
              value={data.preferences.titleGenerationEnabled}
              onChange={(next) =>
                void patchShared('Title generation', { titleGenerationEnabled: next })
              }
            />
            <ToggleRow
              label="Summarise chat status after each turn"
              testID="status-generation"
              value={data.preferences.statusGenerationEnabled}
              onChange={(next) =>
                void patchShared('Status generation', { statusGenerationEnabled: next })
              }
            />
            <Row
              title="Snooze morning hour"
              subtitle="Tomorrow and Next Monday wake at this hour (0–23)"
              right={
                <HourField
                  testID="snooze-morning-hour"
                  label="Snooze morning hour"
                  value={data.preferences.snoozeMorningHour}
                  onCommit={(h) =>
                    void patchShared('Snooze morning hour', { snoozeMorningHour: h })
                  }
                />
              }
            />
            <Row
              title="Snooze evening hour"
              subtitle="The same-day evening preset wakes at this hour (0–23)"
              right={
                <HourField
                  testID="snooze-evening-hour"
                  label="Snooze evening hour"
                  value={data.preferences.snoozeEveningHour}
                  onCommit={(h) =>
                    void patchShared('Snooze evening hour', { snoozeEveningHour: h })
                  }
                />
              }
            />
          </SettingsSection>
        )}
      </WithSettings>
    </SettingsPage>
  );
}
