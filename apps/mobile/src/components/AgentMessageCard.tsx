// AgentMessageCard — a message this chat exchanged with another agent, as one
// card in the transcript: "Sent to <chat>" for what this chat sent
// (`patch_send_to`, a call's hand-off to the chat's agent) and "From <chat>"
// for what came back (a tagged `patch_send_to` delivery, a side thread's
// send-back, the agent's answer to a hand-off). Mirrors web's
// `packages/web/src/components/AgentMessageCard.tsx`.
//
// The other chat's name is the link that opens it. When the other side is not
// a chat the phone can open (the chat's own agent, a side thread) the name is
// plain text.

import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { ArrowUpRight } from 'lucide-react-native';
import { ChatMarkdown } from './ChatMarkdown';
import { radii, space, textMin, useTheme } from '../lib/theme';
import { useChatStore } from '../stores/chatStore';

export type AgentMessageDirection = 'sent' | 'from';

export function AgentMessageCard({
  direction,
  name,
  chatId,
  text,
  status,
  testID,
  extraTargets,
}: {
  direction: AgentMessageDirection;
  /** Who is on the other side: a chat's name, "agent", a side thread's name. */
  name: string;
  /** The other chat, when it is one the card can open. */
  chatId?: string;
  text: string;
  /** A short state beside the label ("Waiting"), when the exchange is open. */
  status?: string;
  testID?: string;
  /** The same message went to these chats too: one card names them all. */
  extraTargets?: { chatId: string; failed?: boolean }[];
}): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const many = extraTargets !== undefined && extraTargets.length > 0;
  return (
    <View
      testID={testID ?? `agent-msg-${direction}`}
      style={{
        backgroundColor: colors.paperRaised,
        borderColor: colors.divider,
        borderWidth: 1,
        borderRadius: radii.lg,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        marginBottom: space.sm,
        gap: space.xs,
      }}
    >
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <Text style={{ fontSize: textMin, color: colors.ink3 }}>
          {many
            ? `Sent to ${extraTargets.length + 1} agents:`
            : direction === 'sent'
              ? 'Sent to'
              : 'From'}
        </Text>
        {chatId ? (
          <Pressable
            testID="agent-msg-link"
            accessibilityRole="link"
            accessibilityLabel={`Open ${name}`}
            onPress={() => router.push(`/chats/${chatId}` as Href)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 1 }}
          >
            <Text
              numberOfLines={1}
              style={{
                fontSize: textMin,
                fontWeight: '600',
                color: colors.leafSoft,
                flexShrink: 1,
              }}
            >
              {name}
            </Text>
            <ArrowUpRight size={13} color={colors.leafSoft} />
          </Pressable>
        ) : (
          <Text
            numberOfLines={1}
            style={{ fontSize: textMin, fontWeight: '600', color: colors.ink, flexShrink: 1 }}
          >
            {name}
          </Text>
        )}
        {many
          ? extraTargets.map((t) => (
              <ExtraTarget key={t.chatId} chatId={t.chatId} failed={t.failed === true} />
            ))
          : null}
        {status ? (
          <Text
            testID="agent-msg-status"
            style={{ marginLeft: 'auto', fontSize: textMin, color: colors.ink3 }}
          >
            {status}
          </Text>
        ) : null}
      </View>
      <View testID="agent-msg-text">
        <ChatMarkdown content={text} color={colors.ink} />
      </View>
    </View>
  );
}

function ExtraTarget({ chatId, failed }: { chatId: string; failed: boolean }): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const name = useChatName(chatId);
  return (
    <Pressable
      testID="agent-msg-target"
      accessibilityRole="link"
      accessibilityLabel={`Open ${name}`}
      onPress={() => router.push(`/chats/${chatId}` as Href)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 1 }}
    >
      <Text
        numberOfLines={1}
        style={{ fontSize: textMin, fontWeight: '600', color: colors.leafSoft, flexShrink: 1 }}
      >
        {failed ? `${name} (not sent)` : name}
      </Text>
      <ArrowUpRight size={13} color={colors.leafSoft} />
    </Pressable>
  );
}

/**
 * The name to show for another chat: its current name when the phone knows it,
 * else the name it carried when the message was sent, else plainly "another
 * chat" — never a guessed one.
 */
export function useChatName(chatId: string, carried?: string | null): string {
  const live = useChatStore((s) => s.chats[chatId]?.name ?? null);
  return live ?? carried ?? 'another chat';
}
