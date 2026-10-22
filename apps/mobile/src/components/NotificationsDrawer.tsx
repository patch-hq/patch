// NotificationsDrawer — the history of what agents sent (spec/09 § bell,
// spec/15 § Notifications drawer). A bottom sheet opened from the bell in the
// Chats header: newest first, unread entries visibly distinct, tapping one
// marks it read and opens its source chat. Pads past the system navigation bar
// once (`insets.bottom`) — portfolio CLAUDE.md § Android nav bar.

import React from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';
import { useChatStore } from '../stores/chatStore';
import { useNotificationsStore } from '../stores/notificationsStore';
import { deriveChatTitle } from '../lib/labels';
import { radii, space, typography, useTheme } from '../lib/theme';

interface DrawerState {
  open: boolean;
  setOpen(open: boolean): void;
}

export const useNotificationsDrawerStore = create<DrawerState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function showNotificationsDrawer(): void {
  useNotificationsDrawerStore.getState().setOpen(true);
  void useNotificationsStore.getState().load();
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function NotificationsDrawer(): React.ReactElement | null {
  const open = useNotificationsDrawerStore((s) => s.open);
  return open ? <DrawerBody /> : null;
}

function DrawerBody(): React.ReactElement {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const close = (): void => useNotificationsDrawerStore.getState().setOpen(false);
  const { items, unread, error, markRead } = useNotificationsStore();
  const chats = useChatStore((s) => s.chats);
  const now = Date.now();

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <Pressable
        testID="notifications-drawer-scrim"
        style={{ flex: 1, backgroundColor: colors.shade }}
        onPress={close}
      >
        <View style={{ flex: 1 }} />
        <Pressable
          testID="notifications-drawer"
          onPress={() => {}}
          style={{
            backgroundColor: colors.paperRaised,
            borderTopLeftRadius: radii.lg,
            borderTopRightRadius: radii.lg,
            paddingTop: space.lg,
            paddingHorizontal: space.lg,
            paddingBottom: space.md + insets.bottom,
            maxHeight: '80%',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.md }}>
            <Text style={{ ...typography.title, color: colors.ink, flex: 1 }}>Notifications</Text>
            <Pressable
              testID="notifications-mark-all"
              accessibilityRole="button"
              accessibilityState={{ disabled: unread === 0 }}
              disabled={unread === 0}
              onPress={() => void markRead({ all: true })}
            >
              <Text
                style={{ ...typography.secondary, color: unread === 0 ? colors.ink3 : colors.ink }}
              >
                Mark all read
              </Text>
            </Pressable>
          </View>
          {error !== null ? (
            <Text
              testID="notifications-error"
              style={{ ...typography.secondary, color: colors.ink }}
            >
              {error}
            </Text>
          ) : items.length === 0 ? (
            <Text
              testID="notifications-empty"
              style={{ ...typography.secondary, color: colors.ink3 }}
            >
              Nothing yet.
            </Text>
          ) : (
            <ScrollView contentContainerStyle={{ gap: space.sm }}>
              {items.map((n) => {
                const unreadRow = n.readAt === null;
                const chat = chats[n.chatId];
                return (
                  <Pressable
                    key={n.id}
                    testID={`notification-item-${n.id}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: unreadRow }}
                    onPress={() => {
                      if (unreadRow) void markRead({ ids: [n.id] });
                      close();
                      router.push(`/chats/${n.chatId}`);
                    }}
                    style={{
                      padding: space.md,
                      borderRadius: radii.sm,
                      borderWidth: 1,
                      borderColor: unreadRow ? colors.ink : colors.divider,
                      backgroundColor: colors.paperRaised,
                    }}
                  >
                    <Text
                      style={{
                        ...typography.meta,
                        color: colors.ink3,
                      }}
                      numberOfLines={1}
                    >
                      {`${chat ? deriveChatTitle(chat) : 'Chat'} · ${ago(n.sentAt, now)}`}
                    </Text>
                    <Text
                      style={{
                        ...typography.secondary,
                        color: colors.ink,
                        fontWeight: unreadRow ? '700' : '400',
                      }}
                    >
                      {n.message}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
