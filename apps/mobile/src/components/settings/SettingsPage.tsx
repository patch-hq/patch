// The frame every Settings page is drawn in (design/settings-redesign, phone
// layout): a back arrow and the page title, the page's one main action on the
// right when it has one, the host switcher under the title on pages whose
// controls belong to one host, then the page's groups.
//
// A page is pushed on the root stack ABOVE the tabs, so no tab bar sits under
// it: its scroll content pads itself past the system navigation bar's inset
// (useSafeAreaInsets().bottom) — counted once, here. The top inset is already
// claimed app-wide by the root layout's SafeAreaView.

import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { useGoBack } from '../../lib/goBack';
import { fonts, space, textMin, useTheme } from '../../lib/theme';
import { HostSwitcher } from './HostSwitcher';
import { SettingsPageContext } from './pageContext';

export function SettingsPage({
  title,
  testID,
  right,
  hostSwitcher = false,
  children,
}: {
  title: string;
  testID: string;
  right?: React.ReactNode;
  hostSwitcher?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const colors = useTheme();
  const meta = React.useContext(SettingsPageContext);
  const goBack = useGoBack('/(tabs)/settings');
  const insets = useSafeAreaInsets();
  return (
    <View testID={testID} style={{ flex: 1, backgroundColor: colors.paper }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: space.sm,
          paddingTop: space.md,
          paddingBottom: space.sm,
          paddingHorizontal: space.md,
        }}
      >
        <Pressable
          testID="settings-back"
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={goBack}
          hitSlop={space.sm}
          style={{ paddingVertical: space.xs, paddingRight: space.xs }}
        >
          <ArrowLeft size={22} color={colors.ink2} />
        </Pressable>
        <Text
          testID="settings-page-title"
          accessibilityRole="header"
          numberOfLines={1}
          style={{
            flex: 1,
            fontFamily: fonts.display,
            fontSize: 22,
            lineHeight: 28,
            color: colors.ink,
          }}
        >
          {meta?.title ?? title}
        </Text>
        {meta?.experimental ? (
          <Text
            testID="settings-experimental-tag"
            style={{
              fontFamily: fonts.bodyMedium,
              fontSize: textMin,
              color: colors.amber,
              backgroundColor: colors.waitingTint,
              borderRadius: 12,
              overflow: 'hidden',
              paddingHorizontal: space.sm,
              paddingVertical: 2,
            }}
          >
            Experimental
          </Text>
        ) : null}
        {right}
      </View>
      {meta?.intro ? (
        <Text
          testID="settings-intro"
          style={{
            fontFamily: fonts.body,
            fontSize: 15,
            lineHeight: 21,
            color: colors.ink3,
            paddingHorizontal: space.md,
            paddingBottom: space.sm,
          }}
        >
          {meta.intro}
        </Text>
      ) : null}
      {hostSwitcher ? (
        <View style={{ paddingHorizontal: space.md, paddingBottom: space.sm }}>
          <HostSwitcher />
        </View>
      ) : null}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: space.md,
          paddingTop: space.sm,
          paddingBottom: insets.bottom + space.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </View>
  );
}
