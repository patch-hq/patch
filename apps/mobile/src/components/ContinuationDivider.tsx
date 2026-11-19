// Where a thread of linked chats hands on (spec/04 § Provider switches,
// § Moving to another host; spec/05 § Capabilities and provider switches).
//
// The newer chat opens with a divider naming the chat it continues and what
// changed (the models, or the hosts); the older one ends with a divider naming
// the chat that continues it. Tapping either opens the other chat.

import React from 'react';
import { Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { compactModelLabel } from '../lib/modelLabel';
import { useChatStore } from '../stores/chatStore';
import { usePresenceStore } from '../stores/presenceStore';
import type { ChatRow } from '../stores/types';
import { space, textMin, useTheme } from '../lib/theme';

/** What changed between two linked chats, e.g. `Opus 5.5 → GPT-5.5` or `laptop → server`. */
export function continuationChange(
  earlier: Pick<ChatRow, 'model' | 'hostId'> | undefined,
  later: Pick<ChatRow, 'model' | 'hostId'> | undefined,
  hostName: (hostId: string) => string,
): string | null {
  if (!earlier || !later) return null;
  if (earlier.hostId !== later.hostId) {
    return `${hostName(earlier.hostId)} → ${hostName(later.hostId)}`;
  }
  if (earlier.model && later.model && earlier.model !== later.model) {
    return `${compactModelLabel(earlier.model)} → ${compactModelLabel(later.model)}`;
  }
  return null;
}

export function ContinuationDivider({
  chatId,
  edge,
}: {
  chatId: string;
  /** `start`: this chat continues another. `end`: another chat continues this one. */
  edge: 'start' | 'end';
}): React.ReactElement | null {
  const router = useRouter();
  const colors = useTheme();
  const row = useChatStore((s) => s.chats[chatId]);
  const otherId = edge === 'start' ? row?.continuedFrom : row?.continuedIn;
  const other = useChatStore((s) => (otherId !== undefined ? s.chats[otherId] : undefined));
  const hosts = usePresenceStore((s) => s.hosts);
  if (!row || otherId === undefined) return null;
  const hostName = (hostId: string): string => hosts[hostId]?.host?.hostName ?? hostId;
  const change =
    edge === 'start'
      ? continuationChange(other, row, hostName)
      : continuationChange(row, other, hostName);
  return (
    <View
      testID={`continuation-${edge}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        marginVertical: space.sm,
      }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: colors.lineSoft }} />
      <Text
        testID={`continuation-${edge}-link`}
        accessibilityRole="link"
        onPress={() => router.push(`/chats/${otherId}` as Href)}
        style={{ color: colors.ink3, fontSize: textMin, flexShrink: 1, textAlign: 'center' }}
      >
        {edge === 'start' ? 'Continued from ' : 'Continued in '}
        <Text style={{ color: colors.ink2 }}>{other?.name ?? 'New chat'}</Text>
        {change !== null ? ` · ${change}` : ''}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.lineSoft }} />
    </View>
  );
}
