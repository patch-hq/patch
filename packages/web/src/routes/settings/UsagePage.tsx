// Settings → Usage: how the allowance is going, which chats spent it, and the
// accounts every host draws from — one card per provider, each drawn the same
// way from its entry in `providers.tsx`. What a turn does after a limit is under
// Settings → Agent (spec/10 § Limits). All shared settings (spec/01 § Settings): nothing
// here is about one host.

import type { JSX } from 'react';
import { Group, SettingsPage } from './ui.js';
import { UsageHistory } from './UsageHistory.js';
import { PROVIDERS } from './providers.js';
import { SharedAccounts } from './SharedAccounts.js';
import { AcpAccounts } from './AcpAccounts.js';

export function UsagePage(): JSX.Element {
  return (
    <SettingsPage
      intro="The Claude, ChatGPT and other accounts your agents run on, and how much of each you've used."
      title="AI accounts"
      testid="settings-usage"
    >
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
      <AcpAccounts />
      <UsageHistory />
    </SettingsPage>
  );
}
