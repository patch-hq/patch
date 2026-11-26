// Settings → Experimental features: a home for half-finished work. Everything
// here is off until the account switches it on, and the switch is account-wide
// (a shared setting), so every surface agrees.

import type { JSX } from 'react';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { Toggle } from '../../components/Toggle.js';
import { failed } from '../../lib/errorCopy.js';
import { Group, Row, SettingsPage } from './ui.js';

export function ExperimentalPage(): JSX.Element {
  const preferences = usePreferencesStore((s) => s.preferences);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);

  return (
    <SettingsPage
      intro="Features that aren't finished yet. Turning this on shows them all."
      title="Experimental features"
      testid="settings-experimental-page"
    >
      <Group testid="settings-experimental">
        <Row
          title="Show experimental features"
          sub="Manager, Batch, Meeting mode, Files, Editor, Terminal, Browser, dictation and calls"
        >
          <Toggle
            checked={preferences.experimentalFeatures}
            disabled={!loaded}
            onChange={(next) => {
              void update({ experimentalFeatures: next }).catch((e: Error) =>
                pushError(failed('settings'), undefined, e.message),
              );
            }}
            testid="experimental-features"
          />
        </Row>
        <Row title="Show Inbox" sub="The Inbox page of agent questions and updates">
          <Toggle
            checked={preferences.experimentalInbox}
            disabled={!loaded}
            onChange={(next) => {
              void update({ experimentalInbox: next }).catch((e: Error) =>
                pushError(failed('settings'), undefined, e.message),
              );
            }}
            testid="experimental-inbox"
          />
        </Row>
      </Group>
    </SettingsPage>
  );
}
