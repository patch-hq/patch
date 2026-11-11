// Settings → Experimental features: a home for half-finished work, off until
// the account switches it on. Account-wide (`PATCH /api/settings`), so web and
// the phone agree.

import React from 'react';
import { SettingsSection } from '../SettingsSection';
import { SettingsPage } from './SettingsPage';
import { ToggleRow, WithSettings } from './ui';
import { writePreferences } from './PreferenceSections';

export function ExperimentalPage(): React.ReactElement {
  return (
    <SettingsPage title="Experimental features" testID="settings-page-experimental">
      <WithSettings testID="experimental">
        {(data) => (
          <SettingsSection testID="settings-experimental">
            <ToggleRow
              label="Show experimental features"
              subtitle="Manager and Batch"
              testID="experimental-features"
              value={data.preferences.experimentalFeatures}
              onChange={(next) => writePreferences({ experimentalFeatures: next })}
            />
          </SettingsSection>
        )}
      </WithSettings>
    </SettingsPage>
  );
}
