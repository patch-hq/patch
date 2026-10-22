// One host's Claude Code settings.json (Settings → Providers → Edit).

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ClaudeSettingsEditor } from '../../src/components/settings/ClaudeSettingsSection';

export default function ClaudeJsonScreen(): React.ReactElement {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  if (!hostId) throw new Error('settings.json opened without a hostId');
  return <ClaudeSettingsEditor hostId={hostId} />;
}
