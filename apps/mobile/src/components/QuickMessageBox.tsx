// QuickMessageBox — a text input and Send, pinned under an open artifact or
// Pad on the phone so a message can go to the chat without leaving the page.
// Deliberately bare: no model, attachments or other composer options.

import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { sendMessage } from '../lib/sendQueue';
import { space, typography, useTheme } from '../lib/theme';

export function QuickMessageBox({ chatId }: { chatId: string }): React.ReactElement {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = React.useState('');
  const trimmed = text.trim();
  const send = (): void => {
    if (trimmed === '') return;
    sendMessage(chatId, trimmed, []);
    setText('');
  };
  return (
    <View
      testID="quick-message"
      style={{
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: space.sm,
        paddingHorizontal: space.sm,
        paddingTop: space.sm,
        paddingBottom: space.sm + insets.bottom,
        borderTopWidth: 1,
        borderColor: colors.divider,
        backgroundColor: colors.paper,
      }}
    >
      <TextInput
        testID="quick-message-input"
        value={text}
        onChangeText={setText}
        placeholder="Message"
        placeholderTextColor={colors.ink3}
        multiline
        style={{
          ...typography.body,
          flex: 1,
          maxHeight: 96,
          color: colors.ink,
          paddingVertical: space.sm,
        }}
      />
      <Pressable
        testID="quick-message-send"
        onPress={send}
        disabled={trimmed === ''}
        accessibilityRole="button"
        accessibilityLabel="Send"
        hitSlop={space.sm}
        style={{ padding: space.sm, opacity: trimmed === '' ? 0.4 : 1 }}
      >
        <Text style={{ ...typography.title, color: colors.ink }}>Send</Text>
      </Pressable>
    </View>
  );
}
