// ChatSignInBar — the Sign in action of a chat that is Waiting for sign-in
// (spec/05 § Chat status). The server says the chat waits on a signed-out
// account; this goes to Settings, where Sign in works from the phone, device
// code and all (spec/10 § Signing in). When no account of the provider is
// connected at all, the not-signed-in bar already says so and carries the same
// action, so this stays quiet.

import React, { type ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { ChatStatusInfo } from '@patch/wire';
import { useSettingsStore } from '../../stores/settingsStore';
import { fonts, space, textMin, useTheme } from '../../lib/theme';
import { BarShell } from './BarShell';

export function ChatSignInBar({
  status,
  model,
}: {
  status: ChatStatusInfo | undefined;
  model: string | null;
}): ReactElement | null {
  const colors = useTheme();
  const router = useRouter();
  const secrets = useSettingsStore((s) => s.data?.shared?.secrets);
  if (status?.state !== 'waiting_for_sign_in') return null;
  const openai = model?.startsWith('openai/') ?? false;
  if (secrets) {
    const kind = model?.startsWith('openai/api/') ? 'apiKey' : 'chatgpt';
    const connected = openai
      ? secrets.codex.some((a) => a.connected && a.kind === kind)
      : secrets.claude.some((a) => a.connected);
    if (!connected) return null;
  }
  return (
    <BarShell testID="chat-signin-bar" tone="alert" role="alert">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text style={{ flex: 1, color: colors.ink, fontSize: textMin }}>
          Signed out of {openai ? 'Codex' : 'Claude'}. This chat is waiting.
        </Text>
        <Pressable
          testID="chat-signin-action"
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
