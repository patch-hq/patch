// Settings → Chats: what patch does to a chat on its own — naming it, and
// summarising where it has got to after each turn. Both spend tokens, which
// is why they are switches; neither is about an account or a limit, which is
// why they are not on Usage. Shared settings (spec/01 § Settings).

import type { JSX } from 'react';
import { Toggle } from '../../components/Toggle.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { patchShared } from './sharedWrite.js';
import { Group, Row, SettingsPage } from './ui.js';

export function ChatsPage(): JSX.Element {
  const titleGen = usePreferencesStore((s) => s.preferences.titleGenerationEnabled);
  const statusGen = usePreferencesStore((s) => s.preferences.statusGenerationEnabled);
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
    </SettingsPage>
  );
}
