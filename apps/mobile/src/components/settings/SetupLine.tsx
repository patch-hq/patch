// The line under a Settings choice that lacks something on a host: an
// invitation with the one-step fix, not an error (spec/15 § Voice readiness).

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { space, typography, useTheme } from '../../lib/theme';

export function SetupLine({ text, testID }: { text: string; testID: string }): React.ReactElement {
  const colors = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
      <Text testID={testID} style={{ ...typography.meta, color: colors.ink2 }}>
        {text}
      </Text>
      <Pressable
        testID={`${testID}-setup`}
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => router.push('/settings/providers' as Href)}
      >
        <Text style={{ ...typography.meta, color: colors.leaf }}>Set up</Text>
      </Pressable>
    </View>
  );
}
