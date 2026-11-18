// WakeSheet — arms a chat's self-wake from the ⋯ menu (spec/02 § Self-wake):
// a loop that repeats every N, or a one-shot wake at a time. Both go through
// `api.setLoop`, the same call as the composer's `/loop`, so they replace any
// wake already pending. The one-shot time is typed as `YYYY-MM-DD HH:mm` (no
// native date picker — that would need a new APK, as in SnoozeSheet).

import React, { useState, type ReactElement } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../api/rest';
import { useUiStore } from '../stores/uiStore';
import { parseCustomSnooze } from '../lib/snooze';
import { radii, space, typography, useTheme } from '../lib/theme';

export function WakeSheet({
  chatId,
  onClose,
}: {
  chatId: string;
  onClose: () => void;
}): ReactElement {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [loop, setLoop] = useState(true);
  const [message, setMessage] = useState('');
  const [every, setEvery] = useState('10m');
  const [at, setAt] = useState('');
  const [saving, setSaving] = useState(false);

  const valid = message.trim() !== '' && (loop ? every.trim() !== '' : at.trim() !== '');

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      if (loop) {
        await api.setLoop(chatId, { message: message.trim(), every: every.trim() });
      } else {
        const when = parseCustomSnooze(at);
        await api.setLoop(chatId, { message: message.trim(), at: new Date(when).toISOString() });
      }
      onClose();
    } catch (e) {
      useUiStore.getState().pushError(`setting wake failed: ${(e as Error).message}`);
      setSaving(false);
    }
  };

  const input = {
    ...typography.body,
    color: colors.ink,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.divider,
  } as const;

  const kind = (isLoop: boolean, label: string): ReactElement => {
    const on = loop === isLoop;
    return (
      <Pressable
        testID={isLoop ? 'wake-sheet-kind-loop' : 'wake-sheet-kind-at'}
        accessibilityRole="button"
        onPress={() => setLoop(isLoop)}
        style={{
          flex: 1,
          alignItems: 'center',
          padding: space.md,
          borderRadius: radii.sm,
          borderWidth: 1,
          borderColor: on ? colors.ink : colors.divider,
          backgroundColor: on ? colors.ink : colors.paperRaised,
        }}
      >
        <Text style={{ ...typography.secondary, color: on ? colors.paperRaised : colors.ink }}>
          {label}
        </Text>
      </Pressable>
    );
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: colors.shade }} onPress={onClose}>
        <View style={{ flex: 1 }} />
        <Pressable
          testID="wake-sheet"
          onPress={() => {}}
          style={{
            backgroundColor: colors.paperRaised,
            borderTopLeftRadius: radii.lg,
            borderTopRightRadius: radii.lg,
            padding: space.lg,
            paddingBottom: space.md + insets.bottom,
            gap: space.md,
          }}
        >
          <Text style={{ ...typography.title, color: colors.ink }}>Loop or wake</Text>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            {kind(true, 'Loop')}
            {kind(false, 'Wake once')}
          </View>
          <TextInput
            testID="wake-sheet-message"
            accessibilityLabel="Message"
            placeholder="Message"
            placeholderTextColor={colors.ink3}
            value={message}
            onChangeText={setMessage}
            multiline
            style={{ ...input, minHeight: 72 }}
          />
          {loop ? (
            <TextInput
              testID="wake-sheet-every"
              accessibilityLabel="Every"
              placeholder="Every: 10m, 1h30m"
              placeholderTextColor={colors.ink3}
              value={every}
              onChangeText={setEvery}
              autoCapitalize="none"
              style={input}
            />
          ) : (
            <TextInput
              testID="wake-sheet-at"
              accessibilityLabel="Wake at"
              placeholder="YYYY-MM-DD HH:mm"
              placeholderTextColor={colors.ink3}
              value={at}
              onChangeText={setAt}
              style={input}
            />
          )}
          <Pressable
            testID="wake-sheet-save"
            accessibilityRole="button"
            disabled={!valid || saving}
            onPress={() => void save()}
            style={{
              alignItems: 'center',
              padding: space.md,
              borderRadius: radii.sm,
              backgroundColor: colors.ink,
              opacity: !valid || saving ? 0.4 : 1,
            }}
          >
            <Text style={{ ...typography.secondary, color: colors.paperRaised }}>Save</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
