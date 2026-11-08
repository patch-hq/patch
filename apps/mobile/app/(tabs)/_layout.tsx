// Bottom-tab layout, left to right: Chats, Jobs, New chat, Files, Settings.
// New chat is the raised green button in the TRUE centre (third of five), so
// the primary action sits under the thumb for one-handed use. Files is an
// ordinary tab to its right, drawn like Chats/Jobs/Settings.

import React from 'react';
import { Pressable, View } from 'react-native';
import { Redirect, Tabs, useRouter } from 'expo-router';
import { Clock, Folder, MessageCircle, Plus, Settings as SettingsIcon } from 'lucide-react-native';
import { fixed, fonts, radii, space, textMin, useTheme } from '../../src/lib/theme';
import { CallPill } from '../../src/components/CallPill';
import { RemoteCallPill } from '../../src/components/RemoteCallPill';
import { getRoute } from '../../src/config';
import { SPECIAL_THREAD_IDS } from '@patch/wire';

/** The tab bar's drawn height (its `tabBarStyle.height`) — the pill floats above it. */
const TAB_BAR_HEIGHT = 64;
void SPECIAL_THREAD_IDS; // imported for side-effect of forcing wire dep into the bundle

// expo-router/react-navigation passes `BottomTabBarButtonProps` whose
// `onPress` signature is wider than ours. We just forward the call.
const NewChatTabButton = (props: {
  onPress?: (...args: unknown[]) => void;
}): React.ReactElement => {
  const colors = useTheme();
  return (
    // The tab CELL: flex:1 claims an equal fifth of the 5-tab bar, and its
    // centre-alignment places the fixed-size raised button on the cell centre.
    // Without this wrapper the bare 64px Pressable took only its own width
    // and hugged the LEFT of its slot.
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Pressable
        onPress={() => {
          props.onPress?.();
        }}
        style={{
          top: -16,
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: colors.leaf,
          alignItems: 'center',
          justifyContent: 'center',
          elevation: 6,
          shadowColor: fixed.shadow,
          shadowOpacity: 0.2,
          shadowRadius: 8,
        }}
        accessibilityLabel="New chat"
      >
        <View style={{ borderRadius: radii.md }}>
          <Plus size={28} color={colors.onAccent} />
        </View>
      </Pressable>
    </View>
  );
};

export default function TabLayout(): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  if (getRoute() === null) return <Redirect href="/pair" />;
  return (
    <View style={{ flex: 1 }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.leaf,
          tabBarInactiveTintColor: colors.ink3,
          tabBarStyle: {
            backgroundColor: colors.paperRaised,
            borderTopColor: colors.lineSoft,
            height: TAB_BAR_HEIGHT,
          },
          tabBarLabelStyle: { fontFamily: fonts.bodyMedium, fontSize: textMin },
        }}
      >
        <Tabs.Screen
          name="chats"
          options={{
            title: 'Chats',
            tabBarIcon: ({ color, size }: { color: string; size: number }) => (
              <MessageCircle size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="jobs"
          options={{
            title: 'Jobs',
            tabBarIcon: ({ color, size }: { color: string; size: number }) => (
              <Clock size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="new"
          // New chat is an ACTION, not a tab you sit on: the press pushes the
          // full-screen flow (a root route, above the tab bar) and the tab itself
          // is never focused. Doing it the other way — letting the tab focus and
          // bouncing off it with <Redirect> — is what left the app on a blank
          // screen, because Redirect re-fires every time the tab regains focus.
          listeners={{
            tabPress: (e: { preventDefault: () => void }) => {
              e.preventDefault();
              router.push('/new-chat');
            },
          }}
          options={{
            title: 'New chat',
            tabBarButton: NewChatTabButton as unknown as never,
          }}
        />
        <Tabs.Screen
          name="files"
          options={{
            title: 'Files',
            tabBarIcon: ({ color, size }: { color: string; size: number }) => (
              <Folder size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: 'Settings',
            tabBarIcon: ({ color, size }: { color: string; size: number }) => (
              <SettingsIcon size={size} color={color} />
            ),
          }}
        />
      </Tabs>
      {/* On-call pill (spec/15 § Voice states): while a call is open and the
          user is on a tab rather than in the call's chat, a small persistent
          pill floats just above the tab bar — tap to return, or end it. It
          renders nothing when there is no call. */}
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          left: space.md,
          right: space.md,
          bottom: TAB_BAR_HEIGHT + space.sm,
        }}
      >
        <CallPill />
        <RemoteCallPill />
      </View>
    </View>
  );
}
