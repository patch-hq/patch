// Settings → Usage: how the allowance is going, which chats spent it, and the
// accounts every host draws from — one card per provider, each drawn the same
// way from its entry in `providers.tsx` — with whether a turn stopped by a
// limit resumes on its own. All shared settings (spec/01 § Settings): nothing
// here is about one machine.

import type { JSX } from 'react';
import { Toggle } from '../../components/Toggle.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { patchShared } from './sharedWrite.js';
import { Group, Row, SettingsPage } from './ui.js';
import { UsageHistory } from './UsageHistory.js';
import { PROVIDERS } from './providers.js';
import { SharedAccounts } from './SharedAccounts.js';

export function UsagePage(): JSX.Element {
  const autoResume = usePreferencesStore((s) => s.preferences.autoResumeRateLimit);
  const loaded = usePreferencesStore((s) => s.loaded);
  return (
    <SettingsPage title="Usage" testid="settings-usage">
      <UsageHistory />
      {PROVIDERS.map((p) => (
        <Group
          key={p.id}
          label={p.name}
          testid={`settings-provider-${p.id}`}
          after={<p.AddAccount />}
        >
          <SharedAccounts provider={p} />
        </Group>
      ))}
      <Group>
        <Row title="Resume automatically when a limit resets" testid="auto-resume-rate-limit">
          <Toggle
            checked={autoResume}
            disabled={!loaded}
            onChange={(next) => void patchShared('auto-resume', { autoResumeRateLimit: next })}
            testid="auto-resume-rate-limit-toggle"
          />
        </Row>
      </Group>
    </SettingsPage>
  );
}
