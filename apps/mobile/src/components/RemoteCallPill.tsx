// Call-in-progress-elsewhere pill (spec/07 § A call can move between devices).
// While another surface holds a call and this phone has none, it says so and
// offers to take the call over: the host ends it there and opens it here.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Phone } from 'lucide-react-native';
import { useVoiceStore } from '../stores/voiceStore';
import { useChatStore } from '../stores/chatStore';
import { startVoiceCall } from '../lib/voiceCall';
import { callChatName } from '../lib/callStatus';
import { fonts, radii, space, textMin, useTheme } from '../lib/theme';

const DEVICE_LABEL: Record<string, string> = {
  mobile: 'another phone',
  web: 'your browser',
  desktop: 'your computer',
};

export function RemoteCallPill(): React.ReactElement | null {
  const colors = useTheme();
  const own = useVoiceStore((s) => s.activeSession);
  const remote = useVoiceStore((s) => Object.values(s.remoteCalls)[0] ?? null);
  const row = useChatStore((s) => (remote ? s.chats[remote.chatId] : undefined));
  if (own || !remote) return null;
  const label = `Call on ${DEVICE_LABEL[remote.surfaceKind] ?? 'another device'} · ${callChatName(remote.chatId, row)}`;
  return (
    <View
      testID="remote-call-pill"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        alignSelf: 'center',
        borderRadius: radii.pill,
        backgroundColor: colors.paperRaised,
        borderWidth: 1,
        borderColor: colors.leaf,
        paddingLeft: space.md,
        paddingVertical: space.xs,
      }}
    >
      <Phone size={14} color={colors.ink} />
      <Text
        style={{ color: colors.ink, fontFamily: fonts.body, fontSize: textMin }}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Pressable
        testID="remote-call-switch"
        accessibilityRole="button"
        accessibilityLabel="Switch the call to this phone"
        onPress={() => startVoiceCall(remote.chatId, 'call', { takeOver: true })}
        style={{ paddingHorizontal: space.md, paddingVertical: space.xs }}
      >
        <Text style={{ color: colors.leaf, fontFamily: fonts.bodyBold, fontSize: textMin }}>
          Switch here
        </Text>
      </Pressable>
    </View>
  );
}
