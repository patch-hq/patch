// Files tab: one row per registered host, each opening that host's Files
// browser (app/hosts/[hostId]/files.tsx). A host is never guessed — Files act
// on one machine's filesystem, so the machine is always the one tapped.
//
// The tab bar below this screen already clears the system navigation bar, so
// the list pads only its own spacing at the bottom — the inset is counted once.

import React from 'react';
import { ScrollView, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { filesRoute } from '../../src/lib/hostFiles';
import { fonts, space, useTheme } from '../../src/lib/theme';
import { usePresenceStore } from '../../src/stores/presenceStore';
import { hostName, NoticeRow, sortedHosts } from '../../src/components/settings/HostSwitcher';
import { hostSubtitle } from '../../src/components/settings/HostsSection';
import { SettingsSection } from '../../src/components/SettingsSection';
import { Chevron, Dot, Row } from '../../src/components/settings/ui';

export default function FilesTab(): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const hosts = usePresenceStore((s) => s.hosts);
  const rows = sortedHosts(hosts);
  return (
    <ScrollView
      testID="files-tab"
      style={{ flex: 1, backgroundColor: colors.paper }}
      contentContainerStyle={{
        paddingHorizontal: space.md,
        paddingTop: space.lg,
        paddingBottom: space.xl,
      }}
    >
      <Text
        accessibilityRole="header"
        style={{
          fontFamily: fonts.display,
          fontSize: 26,
          lineHeight: 34,
          color: colors.ink,
          marginHorizontal: space.xs,
          marginBottom: space.sm,
        }}
      >
        Files
      </Text>
      <SettingsSection testID="files-hosts">
        {rows.length === 0 ? (
          <NoticeRow testID="files-no-hosts" text="No hosts yet" />
        ) : (
          rows.map((h) => (
            <Row
              key={h.hostId}
              testID={`files-host-${h.hostId}`}
              accessibilityLabel={hostName(h)}
              onPress={() => router.push(filesRoute(h.hostId))}
              leading={<Dot on={h.online} />}
              title={hostName(h)}
              subtitle={hostSubtitle(h)}
              right={<Chevron />}
            />
          ))
        )}
      </SettingsSection>
    </ScrollView>
  );
}
