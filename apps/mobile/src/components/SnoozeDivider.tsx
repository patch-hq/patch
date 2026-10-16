// SnoozeDivider — the permanent mark in a transcript where a snooze began
// (spec/04 § Snooze → Back): "Snoozed 19:42 – 08:00 · finished 03:52". It stays
// in history after the Back state clears.

import React from 'react';
import { Text, View } from 'react-native';
import { AlarmClock } from 'lucide-react-native';
import { snoozeDividerText, type SnoozeRecord } from '@patch/wire';
import { space, typography, useTheme } from '../lib/theme';

export function SnoozeDivider({ record }: { record: SnoozeRecord }): React.ReactElement {
  const colors = useTheme();
  const line = { flex: 1, height: 1, backgroundColor: colors.divider } as const;
  return (
    <View
      testID="snooze-divider"
      accessibilityRole="text"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        marginVertical: space.lg,
        paddingHorizontal: space.lg,
      }}
    >
      <View style={line} />
      <AlarmClock size={13} color={colors.ink3} />
      <Text style={{ ...typography.meta, color: colors.ink3 }}>{snoozeDividerText(record)}</Text>
      <View style={line} />
    </View>
  );
}
