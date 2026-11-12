// SnoozeDivider — the permanent mark in a transcript where a snooze began
// (spec/04 § Snooze → Back): "Snoozed 19:42 – 08:00 · finished 03:52". It stays
// in history after the Back state clears.

import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AlarmClock } from 'lucide-react-native';
import { snoozeDividerText, type SnoozeRecord } from '@patch/wire';
import { space, typography, useTheme } from '../lib/theme';

export function SnoozeDivider({ record }: { record: SnoozeRecord }): React.ReactElement {
  const colors = useTheme();
  const [open, setOpen] = useState(false);
  const error = record.outcome.kind === 'errored' ? record.outcome.error : undefined;
  const line = { flex: 1, height: 1, backgroundColor: colors.divider } as const;
  return (
    <View style={{ marginVertical: space.lg, paddingHorizontal: space.lg, gap: space.sm }}>
      <View
        testID="snooze-divider"
        accessibilityRole="text"
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}
      >
        <View style={line} />
        <AlarmClock size={13} color={colors.ink3} />
        <Text style={{ ...typography.meta, color: colors.ink3 }}>{snoozeDividerText(record)}</Text>
        {error ? (
          <Pressable
            testID="snooze-error-toggle"
            accessibilityRole="button"
            onPress={() => setOpen((v) => !v)}
          >
            <Text
              style={{ ...typography.meta, color: colors.red, textDecorationLine: 'underline' }}
            >
              {open ? 'Hide details' : 'Details'}
            </Text>
          </Pressable>
        ) : null}
        <View style={line} />
      </View>
      {error && open ? (
        <Text
          testID="snooze-error-detail"
          selectable
          style={{ ...typography.meta, color: colors.ink2 }}
        >
          {error.code}: {error.message}
        </Text>
      ) : null}
    </View>
  );
}
