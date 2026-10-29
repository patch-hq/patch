// App-level daemon-offline banner. A first-class, self-explaining state — not
// silent degradation (spec/12 § Daemon-offline UX; spec/15 § Offline / error
// states). Distinct from the WS `reconnecting` banner: the server can be
// reachable while the host is down. Taps through to Settings → Hosts.

import React from 'react';
import { Pressable, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { describeHostOffline } from '@patch/wire';
import { usePresenceStore } from '../stores/presenceStore';
import { useUiStore } from '../stores/uiStore';
import { hostOfflineBannerText } from '../lib/connection';
import { radii, space, textMin, typography, useTheme } from '../lib/theme';

export function HostOfflineBanner(): React.ReactElement | null {
  const colors = useTheme();
  const router = useRouter();
  const daemon = usePresenceStore((s) => s.daemon);
  const setDiagnosticsOpen = useUiStore((s) => s.setDiagnosticsOpen);
  // Why each machine dropped off, where the server could tell from its last heartbeat.
  const why = usePresenceStore((s) =>
    Object.values(s.hosts)
      .filter((h) => !h.online && h.offlineReason)
      .map((h) =>
        describeHostOffline((h.host?.hostName ?? h.hostId).trim(), h.offlineReason ?? undefined),
      )
      .join('. '),
  );
  const text = hostOfflineBannerText(daemon);
  if (text === null) return null;
  return (
    <Pressable
      testID="daemon-offline-banner"
      onPress={() => router.push('/(tabs)/settings')}
      accessibilityRole="button"
      accessibilityLabel="Machine offline — open Settings to see the machine status"
      style={{
        backgroundColor: colors.waitingTint,
        borderColor: colors.waiting,
        borderWidth: 1,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderRadius: radii.md,
        margin: space.sm,
      }}
    >
      <Text style={{ color: colors.waiting, ...typography.meta }}>{text}</Text>
      {why !== '' ? (
        <Text style={{ color: colors.waiting, fontSize: textMin, marginTop: space.xs }}>
          {why}.
        </Text>
      ) : null}
      <Text style={{ color: colors.waiting, fontSize: textMin, marginTop: space.xs }}>
        Tap for Settings → Hosts.
      </Text>
      {/* Diagnose, not a dead end: opens the diagnostics screen as a dismissible
          overlay (spec/12 § Connection diagnostics screen). The app stays
          navigable — a daemon-offline surface is never blocked. */}
      <Pressable
        testID="daemon-offline-diagnose"
        accessibilityRole="button"
        accessibilityLabel="Diagnose the connection"
        onPress={() => setDiagnosticsOpen(true)}
      >
        <Text
          style={{
            color: colors.waiting,
            fontSize: textMin,
            marginTop: space.xs,
            textDecorationLine: 'underline',
          }}
        >
          Diagnose
        </Text>
      </Pressable>
    </Pressable>
  );
}
