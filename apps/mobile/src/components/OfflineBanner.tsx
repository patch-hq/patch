// Amber WS banner at the top of the chat list. Shown for `reconnecting` /
// `offline` ONLY — never for the initial `connecting` state (NO offline flash
// on load) and never when connected — and only after the link has been down
// for the disconnect grace with the app in the foreground, so opening an idle
// app does not flash it. Per spec/15 § Offline / error states.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { usePresenceStore } from '../stores/presenceStore';
import { useUiStore } from '../stores/uiStore';
import { offlineBannerText } from '../lib/connection';
import { radii, space, typography, useTheme } from '../lib/theme';

export function OfflineBanner(): React.ReactElement | null {
  const colors = useTheme();
  const conn = usePresenceStore((s) => s.connection);
  const outageVisible = usePresenceStore((s) => s.outageVisible);
  const serverLost = usePresenceStore((s) => s.serverLost);
  const setDiagnosticsOpen = useUiStore((s) => s.setDiagnosticsOpen);
  const label = offlineBannerText(conn, outageVisible, serverLost);
  if (label === null) return null;
  return (
    <View
      testID="offline-banner"
      style={{
        backgroundColor: colors.waitingTint,
        borderColor: colors.waiting,
        borderWidth: 1,
        paddingHorizontal: space.md,
        paddingVertical: space.xs,
        borderRadius: radii.md,
        marginHorizontal: space.sm,
        marginTop: space.sm,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View
          testID="offline-dot"
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: colors.waiting,
            marginRight: space.sm,
          }}
        />
        <Text style={{ color: colors.waiting, ...typography.meta }}>{label}</Text>
      </View>
      {/* spec/12 § Connection diagnostics screen: 'Reconnecting…' on its own is
          a dead end — the banner must open the diagnostics screen. */}
      <Pressable
        testID="offline-diagnose"
        accessibilityRole="button"
        accessibilityLabel="Diagnose the connection"
        onPress={() => setDiagnosticsOpen(true)}
      >
        <Text
          style={{ color: colors.waiting, ...typography.meta, textDecorationLine: 'underline' }}
        >
          Diagnose
        </Text>
      </Pressable>
    </View>
  );
}
