// Settings → Chats: what patch does to a chat on its own — naming it, and
// summarising where it has got to after each turn. Neither is about an
// account or a limit, so neither is on Usage. Shared settings (spec/01 § Settings).

import React from 'react';
import { SettingsSection } from '../SettingsSection';
import { SettingsPage } from './SettingsPage';
import { patchShared } from './sharedWrite';
import { ToggleRow, WithSettings } from './ui';

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
          </SettingsSection>
        )}
      </WithSettings>
    </SettingsPage>
  );
}
