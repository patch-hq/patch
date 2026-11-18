// FirstRunIntro — the short welcome on a new chat until dismissed. Remembered
// per account (shared `introDismissed`), so it follows the user across surfaces.
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSettingsStore } from '../stores/settingsStore';
import { writePreferences } from './settings/PreferenceSections';
import { GUIDE_ITEMS, GUIDE_PURPOSE } from '../lib/guide';
import { fonts, radii, space, useTheme } from '../lib/theme';

export function FirstRunIntro(): React.ReactElement | null {
  const colors = useTheme();
  const data = useSettingsStore((s) => s.data);
  if (!data || data.preferences.introDismissed) return null;
  return (
    <View
      testID="first-run-intro"
      style={{ paddingHorizontal: space.xl, paddingVertical: space.md }}
    >
      <Text style={{ fontFamily: fonts.body, fontSize: 14, color: colors.ink2 }}>
        {GUIDE_PURPOSE}
      </Text>
      {GUIDE_ITEMS.map((item) => (
        <Text
          key={item}
          style={{ fontFamily: fonts.body, fontSize: 14, color: colors.ink3, marginTop: 2 }}
        >
          {item}
        </Text>
      ))}
      <Pressable
        testID="first-run-dismiss"
        accessibilityRole="button"
        onPress={() => writePreferences({ introDismissed: true })}
        style={{
          alignSelf: 'flex-start',
          marginTop: space.sm,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          borderRadius: radii.lg,
          borderWidth: 1,
          borderColor: colors.divider,
        }}
      >
        <Text style={{ color: colors.ink2, fontFamily: fonts.body, fontSize: 14 }}>Dismiss</Text>
      </Pressable>
    </View>
  );
}
