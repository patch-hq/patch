// One usage line per connected subscription account on the new-chat screen
// (spec/15 § New chat flow), so the account a chat starts on is chosen with its
// headroom in view. The same freshest-reading rule as Settings → Usage.

import React from 'react';
import { Text, View } from 'react-native';
import { usePresenceStore } from '../stores/presenceStore';
import { useSettingsStore } from '../stores/settingsStore';
import { formatUtilization } from '../lib/usage';
import { space, textMin, useTheme } from '../lib/theme';

const BACKENDS = [
  { id: 'claude-code', name: 'Claude' },
  { id: 'codex', name: 'ChatGPT' },
] as const;

export function AccountUsageStrip(): React.ReactElement | null {
  const colors = useTheme();
  const secrets = useSettingsStore((s) => s.data?.shared?.secrets);
  const hosts = usePresenceStore((s) => s.hosts);
  if (!secrets) return null;
  const lines: { key: string; text: string }[] = [];
  for (const { id, name } of BACKENDS) {
    const accounts = id === 'claude-code' ? secrets.claude : secrets.codex;
    for (const a of accounts) {
      if (!a.connected || ('kind' in a && a.kind === 'apiKey')) continue;
      let usage;
      let readAt = -1;
      for (const h of Object.values(hosts)) {
        const u = h.accounts[id]?.accounts?.find((x) => x.id === a.id)?.usage;
        if (u && (u.at ?? 0) > readAt) {
          usage = u;
          readAt = u.at ?? 0;
        }
      }
      lines.push({
        key: `${id}-${a.id}`,
        text: `${name} · ${a.label}   ${
          usage
            ? `5h ${formatUtilization(usage.session)} · wk ${formatUtilization(usage.week)}`
            : 'not read yet'
        }`,
      });
    }
  }
  if (lines.length === 0) return null;
  return (
    <View testID="new-chat-usage" style={{ paddingHorizontal: space.lg, marginTop: space.md }}>
      {lines.map((l) => (
        <Text
          key={l.key}
          testID={`new-chat-usage-${l.key}`}
          style={{ color: colors.ink3, fontSize: textMin }}
        >
          {l.text}
        </Text>
      ))}
    </View>
  );
}
