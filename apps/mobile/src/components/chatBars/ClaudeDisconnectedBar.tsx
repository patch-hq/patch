// ClaudeDisconnectedBar — shown when no account is connected for the chat's
// backend. Mobile port of web's ClaudeDisconnectedBanner
// (packages/web/src/components/ClaudeDisconnectedBanner.tsx), same rule:
// provider accounts belong to the user, not to a host (spec/10), so it reads
// the server's shared accounts and never names a host, and only on a definite
// "none connected" — never a guess before the settings have loaded. The state
// is otherwise invisible (a send just fails), so this is the case where text IS
// the feature: what's wrong, and where to fix it.

import React, { type ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { modelAccountConnected, providerLabelForModel } from '@patch/wire';
import { useSettingsStore } from '../../stores/settingsStore';
import { fonts, space, textMin, useTheme } from '../../lib/theme';
import { BarShell } from './BarShell';

export function ClaudeDisconnectedBar({ model }: { model: string | null }): ReactElement | null {
  const colors = useTheme();
  const router = useRouter();
  const secrets = useSettingsStore((s) => s.data?.shared?.secrets);
  if (!secrets) return null;
  if (modelAccountConnected(secrets, model)) return null;

  return (
    <BarShell testID="claude-disconnected-bar" tone="alert" role="alert">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text style={{ flex: 1, color: colors.ink, fontSize: textMin }}>
          Not signed in to {providerLabelForModel(model)}. Chats can’t run.
        </Text>
        <Pressable
          testID="claude-disconnected-signin"
          accessibilityRole="link"
          accessibilityLabel="Sign in"
          onPress={() => router.push('/(tabs)/settings')}
          hitSlop={8}
        >
          <Text style={{ color: colors.leaf, fontSize: textMin, fontFamily: fonts.bodyMedium }}>
            Sign in
          </Text>
        </Pressable>
      </View>
    </BarShell>
  );
}
