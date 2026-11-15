// Triage (spec/14 § Triage, experimental): one waiting chat at a time. The
// agent's last message in full, a box to answer it, Send. Sending marks the chat
// read and moves on to the next; one that finishes meanwhile joins the end.

import React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ArrowLeft } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useChatStore } from '../src/stores/chatStore';
import { getWs } from '../src/api/ws';
import { sendMessage } from '../src/lib/sendQueue';
import { useGoBack } from '../src/lib/goBack';
import { deriveChatTitle } from '../src/lib/labels';
import { lastAssistantMessage, triageQueue } from '../src/lib/triageQueue';
import { ChatMarkdown } from '../src/components/ChatMarkdown';
import { fonts, radii, space, textMin, typography, useTheme } from '../src/lib/theme';

export default function TriageScreen(): React.ReactElement {
  const colors = useTheme();
  const goBack = useGoBack('/(tabs)/jobs');
  const insets = useSafeAreaInsets();
  const chats = useChatStore((s) => s.chats);
  const timelines = useChatStore((s) => s.timelines);
  const [answered, setAnswered] = React.useState<ReadonlyMap<string, number>>(new Map());
  const [draft, setDraft] = React.useState('');
  const queue = React.useMemo(() => triageQueue(chats, answered), [chats, answered]);
  const current = queue[0];
  const currentId = current?.chatId;

  // The transcript of a chat nobody has opened is not loaded yet; ask for it.
  React.useEffect(() => {
    if (currentId) getWs().requestReplay(currentId);
  }, [currentId]);
  React.useEffect(() => {
    setDraft('');
  }, [currentId]);

  const message = currentId ? lastAssistantMessage(timelines[currentId]) : null;

  const send = (): void => {
    const text = draft.trim();
    if (!current || text === '') return;
    sendMessage(current.chatId, text, []);
    useChatStore.getState().markRead(current.chatId);
    const seq = useChatStore.getState().chats[current.chatId]?.lastSeq ?? current.lastSeq;
    setAnswered((prev) => new Map(prev).set(current.chatId, seq));
  };

  return (
    <KeyboardAvoidingView
      testID="triage-screen"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: colors.paper }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingTop: space.md,
          paddingHorizontal: space.md,
          paddingBottom: space.sm,
        }}
      >
        <Pressable
          testID="triage-back"
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={goBack}
          hitSlop={8}
        >
          <ArrowLeft size={22} color={colors.ink} />
        </Pressable>
        <Text style={{ ...typography.title, color: colors.ink, flex: 1 }}>Triage</Text>
        <Text testID="triage-count" style={{ color: colors.ink3, fontSize: textMin }}>
          {queue.length} waiting
        </Text>
      </View>
      {current ? (
        <>
          <ScrollView
            testID="triage-card"
            contentContainerStyle={{ paddingHorizontal: space.md, paddingBottom: space.md }}
          >
            <Text
              testID="triage-title"
              style={{ ...typography.label, color: colors.ink2, marginBottom: space.sm }}
            >
              {deriveChatTitle(current)}
            </Text>
            {message === null ? (
              <Text testID="triage-loading" style={{ color: colors.ink3 }}>
                Loading…
              </Text>
            ) : (
              <ChatMarkdown content={message} color={colors.ink} />
            )}
          </ScrollView>
          <View
            style={{
              gap: space.sm,
              padding: space.md,
              paddingBottom: insets.bottom + space.md,
              borderTopWidth: 1,
              borderColor: colors.lineSoft,
            }}
          >
            <TextInput
              testID="triage-input"
              accessibilityLabel="Reply"
              value={draft}
              onChangeText={setDraft}
              multiline
              placeholderTextColor={colors.ink3}
              style={{
                minHeight: 72,
                maxHeight: 160,
                borderWidth: 1,
                borderColor: colors.divider,
                borderRadius: radii.md,
                padding: space.sm,
                color: colors.ink,
                fontFamily: fonts.body,
                textAlignVertical: 'top',
              }}
            />
            <Pressable
              testID="triage-send"
              accessibilityRole="button"
              accessibilityLabel="Send"
              accessibilityState={{ disabled: draft.trim() === '' }}
              disabled={draft.trim() === ''}
              onPress={send}
              style={{
                alignItems: 'center',
                paddingVertical: space.sm,
                borderRadius: radii.md,
                backgroundColor: colors.leaf,
                opacity: draft.trim() === '' ? 0.4 : 1,
              }}
            >
              <Text style={{ color: colors.onAccent, fontFamily: fonts.bodyBold }}>Send</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <Text
          testID="triage-empty"
          style={{ color: colors.ink3, textAlign: 'center', padding: space.xl }}
        >
          Nothing waiting.
        </Text>
      )}
    </KeyboardAvoidingView>
  );
}
