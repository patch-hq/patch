// Settings → Chats: what patch does to a chat on its own — naming it, and
// summarising where it has got to after each turn, and the account those two
// calls run on. Shared settings (spec/01 § Settings).

import React from 'react';
import { Alert } from 'react-native';
import { SettingsSection } from '../SettingsSection';
import { SettingsPage } from './SettingsPage';
import { patchShared } from './sharedWrite';
import { Chips, Field, Row, ToggleRow, WithSettings } from './ui';
import { BACKGROUND_ACCOUNT_AUTO } from '@patch/wire';

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

/**
 * The Claude account titles and status summaries run on (spec/10 § Choosing
 * an account): Automatic, the way a turn chooses, or one account by name —
 * the only way these calls reach an account with auto off.
 */
function BackgroundAccountRow({
  selected,
  accounts,
}: {
  /** Absent from an older server's settings, which reads as `auto` (the wire default). */
  selected: string | undefined;
  accounts: ReadonlyArray<{ id: string; label: string }>;
}): React.ReactElement {
  const current = selected ?? BACKGROUND_ACCOUNT_AUTO;
  const labels = new Map<string, string>([
    [BACKGROUND_ACCOUNT_AUTO, 'Automatic'],
    ...accounts.map((a): [string, string] => [a.id, a.label]),
  ]);
  // A setting naming an account this list no longer holds is shown as it is, never re-read as Automatic.
  if (!labels.has(current)) labels.set(current, `${current} (not held)`);
  return (
    <Row title="Account for titles and status" testID="background-account" stack>
      <Chips
        options={[...labels.keys()]}
        selected={current}
        labelOf={(id) => labels.get(id) ?? id}
        testIDPrefix="background-account"
        labelPrefix="Account for titles and status"
        onSelect={(id) =>
          void patchShared('Account for titles and status', { backgroundAccount: id })
        }
      />
    </Row>
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
            <BackgroundAccountRow
              selected={data.preferences.backgroundAccount}
              accounts={data.shared?.secrets.claude ?? []}
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
