// Settings → Chats: what patch does to a chat on its own — naming it, and
// summarising where it has got to after each turn. Both spend tokens, which
// is why they are switches; neither is about an account or a limit, which is
// why they are not on Usage. Shared settings (spec/01 § Settings).

import type { JSX } from 'react';
import { Toggle } from '../../components/Toggle.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { patchShared } from './sharedWrite.js';
import { hourLabel } from '../../lib/snoozePresets.js';
import { Group, Row, SettingsPage } from './ui.js';

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function ChatsPage(): JSX.Element {
  const titleGen = usePreferencesStore((s) => s.preferences.titleGenerationEnabled);
  const statusGen = usePreferencesStore((s) => s.preferences.statusGenerationEnabled);
  const morning = usePreferencesStore((s) => s.preferences.snoozeMorningHour);
  const evening = usePreferencesStore((s) => s.preferences.snoozeEveningHour);
  const loaded = usePreferencesStore((s) => s.loaded);
  return (
    <SettingsPage title="Chats" testid="settings-chats">
      <Group>
        <Row title="Generate chat titles" testid="title-generation">
          <Toggle
            checked={titleGen}
            disabled={!loaded}
            onChange={(next) =>
              void patchShared('title generation', { titleGenerationEnabled: next })
            }
            testid="title-generation-toggle"
          />
        </Row>
        <Row title="Summarise chat status after each turn" testid="status-generation">
          <Toggle
            checked={statusGen}
            disabled={!loaded}
            onChange={(next) =>
              void patchShared('status generation', { statusGenerationEnabled: next })
            }
            testid="status-generation-toggle"
          />
        </Row>
      </Group>
      <Group label="Snooze defaults" testid="settings-snooze">
        <Row title="Morning wake time (Tomorrow, Next Monday)" testid="snooze-morning">
          <HourSelect
            label="Snooze morning hour"
            value={morning}
            disabled={!loaded}
            testid="snooze-morning-hour"
            onChange={(h) => void patchShared('snooze morning hour', { snoozeMorningHour: h })}
          />
        </Row>
        <Row title="Evening wake time (same day)" testid="snooze-evening">
          <HourSelect
            label="Snooze evening hour"
            value={evening}
            disabled={!loaded}
            testid="snooze-evening-hour"
            onChange={(h) => void patchShared('snooze evening hour', { snoozeEveningHour: h })}
          />
        </Row>
      </Group>
    </SettingsPage>
  );
}

function HourSelect(props: {
  label: string;
  value: number;
  disabled: boolean;
  testid: string;
  onChange: (hour: number) => void;
}): JSX.Element {
  return (
    <select
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      data-testid={props.testid}
      onChange={(e) => props.onChange(Number(e.target.value))}
    >
      {HOURS.map((h) => (
        <option key={h} value={h}>
          {String(h).padStart(2, '0')}:00 ({hourLabel(h)})
        </option>
      ))}
    </select>
  );
}
