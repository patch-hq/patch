// ParentChatBar — the chat-detail bar linking a chat another chat launched with
// `patch_spawn` back to that chat (spec/15 § Chat detail → Status bars). Mirrors
// the web ParentChatBar (packages/web/src/components/ParentChatBar.tsx). No bar
// on a chat no other chat launched.

import React, { type ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { MessageSquareShare, X } from 'lucide-react-native';
import { useChatStore } from '../../stores/chatStore';
import type { ChatRow } from '../../stores/types';
import { fonts, space, textMin, useTheme } from '../../lib/theme';

// Chats whose bar the user dismissed, for the life of the app.
const dismissed = new Set<string>();

export function ParentChatBar({ row }: { row: ChatRow }): ReactElement | null {
  const colors = useTheme();
  const router = useRouter();
  const parentChatId = row.parentChatId ?? null;
  const parentName = useChatStore((s) =>
    parentChatId === null ? null : (s.chats[parentChatId]?.name ?? null),
  );
  const [hidden, setHidden] = React.useState(dismissed.has(row.chatId));
  if (parentChatId === null || hidden) return null;

  const label = parentName !== null ? `Started by "${parentName}" chat` : 'Started by another chat';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Pressable
        testID="parent-chat-bar"
        accessibilityRole="link"
        accessibilityLabel="Open chat"
        onPress={() => router.push(`/chats/${parentChatId}`)}
        style={{
          flex: 1,
          paddingHorizontal: space.md,
          paddingVertical: space.xs,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.xs,
        }}
      >
        <MessageSquareShare size={14} color={colors.ink2} />
        <Text
          testID="parent-chat-bar-link"
          numberOfLines={1}
          style={{ color: colors.ink2, fontFamily: fonts.bodyMedium, fontSize: textMin, flex: 1 }}
        >
          {label}
        </Text>
      </Pressable>
      <Pressable
        testID="parent-chat-bar-dismiss"
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        hitSlop={8}
        onPress={() => {
          dismissed.add(row.chatId);
          setHidden(true);
        }}
        style={{ paddingHorizontal: space.md, paddingVertical: space.xs }}
      >
        <X size={14} color={colors.ink2} />
      </Pressable>
    </View>
  );
}
