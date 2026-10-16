// Bottom-sheet row-actions menu for a chat row. Spec/15 § Row tools:
//   - Show (a hidden chat only)
//   - Pin / unpin
//   - Snooze / Unsnooze
//   - Archive / Unarchive
//   - Send voice note
//   - Delete chat (last, away from the everyday three)
// Pin/Snooze/Archive are the swipe tray's three, in the same order, mirroring
// the web sidebar row's own tools order (`14-design-web.md` § Row tools —
// archive · pin · mic). Batch membership is automatic (spec/15 § Batch view)
// — no per-row toggle here.
//
// Opened from the row's ⋯ (kebab) affordance and from long-press. The raw wire
// event log is NOT a chat affordance — it is a developer surface via the CLI,
// per spec/15 ## Chat detail / spec/12 § Observability.
//
// Implemented via React Native <Modal> + a slim Zustand store. The
// existing call sites trigger via showChatLongPressSheet(row).

import React from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import {
  Archive,
  AlarmClock,
  AlarmClockOff,
  Eye,
  EyeOff,
  Mic,
  PackageOpen,
  Pencil,
  Pin,
  Trash2,
} from 'lucide-react-native';
import { create } from 'zustand';
import { isReservedSpecialThread } from '@patch/wire';
import type { ChatRow as ChatRowT } from '../stores/types';
import { isHidden, isSnoozed } from '../stores/types';
import { useChatStore } from '../stores/chatStore';
import { useUiStore } from '../stores/uiStore';
import { startVoiceNote } from '../lib/voiceNote';
import { showSnoozeSheet } from './SnoozeSheet';
import { api } from '../api/rest';
import { fonts, radii, space, typography, useTheme } from '../lib/theme';

interface SheetState {
  row: ChatRowT | null;
  /**
   * Which page the sheet is on. The presets REPLACE the actions rather than
   * expanding beneath them — a phone sheet that grew to eleven rows would push
   * its own bottom off the screen.
   */
  page: 'actions' | 'rename';
  show(row: ChatRowT, page?: SheetState['page']): void;
  close(): void;
  setPage(page: SheetState['page']): void;
}

const useSheetStore = create<SheetState>((set) => ({
  row: null,
  page: 'actions',
  show(row, page = 'actions') {
    set({ row, page });
  },
  close() {
    set({ row: null, page: 'actions' });
  },
  setPage(page) {
    set({ page });
  },
}));

export function showChatLongPressSheet(row: ChatRowT): void {
  useSheetStore.getState().show(row);
}

/** Open the Snooze sheet for a chat (spec/15 § Snooze sheet) — the row sheet's and the chat-detail kebab's "Snooze chat". */
export function showChatSnoozeSheet(row: ChatRowT): void {
  showSnoozeSheet({ kind: 'chat', chatId: row.chatId });
}

/**
 * Optimistic rename with an honest revert. Seeded from the STORED name, never
 * the displayed label, so a derived folder name is not promoted into a real one.
 * Empty clears the name back to the derived label.
 */
export function renameChatRow(chatId: string, raw: string): void {
  const previous = useChatStore.getState().chats[chatId]?.name ?? null;
  const next = raw.trim() === '' ? null : raw.trim();
  if (next === previous) return;
  useChatStore.getState().setName(chatId, next);
  void api.renameChat(chatId, next).catch((e: Error) => {
    useChatStore.getState().setName(chatId, previous);
    useUiStore.getState().pushError(`rename failed: ${e.message}`);
  });
}

function RenamePage({ row, onDone }: { row: ChatRowT; onDone: () => void }): React.ReactElement {
  const colors = useTheme();
  const [value, setValue] = React.useState(row.name ?? '');
  const commit = (): void => {
    onDone();
    renameChatRow(row.chatId, value);
  };
  return (
    <View style={{ paddingHorizontal: space.lg }}>
      <TextInput
        testID="rename-input"
        accessibilityLabel="Chat name"
        value={value}
        onChangeText={setValue}
        onSubmitEditing={commit}
        autoFocus
        selectTextOnFocus
        returnKeyType="done"
        style={{ ...typography.body, color: colors.ink, paddingVertical: space.sm }}
      />
      <Item icon={<Pencil size={18} color={colors.ink2} />} label="Save name" onPress={commit} />
    </View>
  );
}

/** Archive/unarchive toggle — the one implementation the row sheet's Item and
 * the swipe-to-archive gesture (ChatRow.tsx) both call, so there is exactly
 * one place that decides what "archive" does. */
export function toggleArchive(row: ChatRowT): void {
  const archived = row.status !== 'archived';
  useChatStore.getState().setArchived(row.chatId, archived);
  void api.archiveChat(row.chatId, archived).catch((e: Error) => {
    useChatStore.getState().setArchived(row.chatId, !archived);
    useUiStore.getState().pushError(`${archived ? 'archive' : 'unarchive'} failed: ${e.message}`);
  });
}

/** Pin/unpin toggle — same reasoning as `toggleArchive`. */
export function togglePin(row: ChatRowT): void {
  const pinned = !row.pinned;
  useChatStore.getState().setPinned(row.chatId, pinned);
  void api.pinChat(row.chatId, pinned).catch((e: Error) => {
    // Back to what it was, pin time included: a refused unpin must not turn
    // into a fresh pin that jumps to the top of Pinned.
    useChatStore.getState().setPinned(row.chatId, row.pinned, row.pinnedAt);
    useUiStore.getState().pushError(`${pinned ? 'pin' : 'unpin'} failed: ${e.message}`);
  });
}

/**
 * Delete a chat. Optimistic like the rest, so a refusal has to put the chat
 * back — the row AND its transcript — and say so, or it would vanish from the
 * list while it still exists on the host.
 */
export function deleteChatRow(row: ChatRowT): void {
  const held = useChatStore.getState().removeChat(row.chatId);
  void api.deleteChat(row.chatId).catch((e: Error) => {
    if (held) useChatStore.getState().restoreChat(held);
    useUiStore.getState().pushError(`delete failed: ${e.message}`);
  });
}

/**
 * Optimistic snooze with an honest revert. A rejected request (the server 400s a
 * past `snoozedUntil`, spec/04 § Snooze) puts the previous value back and shows
 * the error — never a silent no-op, and never a quietly-corrected time.
 */
export function applySnooze(chatId: string, snoozedUntil: number | null): void {
  const previous = useChatStore.getState().chats[chatId]?.snoozedUntil ?? null;
  useChatStore.getState().setSnoozed(chatId, snoozedUntil);
  void api.snoozeChat(chatId, snoozedUntil).catch((e: Error) => {
    useChatStore.getState().setSnoozed(chatId, previous);
    useUiStore
      .getState()
      .pushError(`${snoozedUntil === null ? 'unsnooze' : 'snooze'} failed: ${e.message}`);
  });
}

/**
 * Show a hidden chat (spec/04 § Hidden): `hidden: false` moves it into the
 * active list without sending it anything. The one implementation the sheet,
 * the swipe tray, the ⋯ menu and the Hidden bar all call. Optimistic, with an
 * honest revert and a toast when the host refuses it — never a silent no-op.
 */
export function showHiddenChat(chatId: string): void {
  useChatStore.getState().setHidden(chatId, false);
  void api.hideChat(chatId, false).catch((e: Error) => {
    useChatStore.getState().setHidden(chatId, true);
    useUiStore.getState().pushError(`show failed: ${e.message}`);
  });
}

/**
 * Hide a running chat (spec/04 § Hidden): it keeps running but leaves the
 * list, and the host tells the agent it is now in hidden mode. Optimistic,
 * with an honest revert and a toast when the host refuses.
 */
export function hideChat(chatId: string): void {
  useChatStore.getState().setHidden(chatId, true);
  void api.hideChat(chatId, true).catch((e: Error) => {
    useChatStore.getState().setHidden(chatId, false);
    useUiStore.getState().pushError(`hide failed: ${e.message}`);
  });
}

interface ItemProps {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}
function Item({ icon, label, onPress, destructive }: ItemProps): React.ReactElement {
  const colors = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        backgroundColor: pressed ? colors.divider : 'transparent',
      })}
    >
      <View style={{ width: 24 }}>{icon}</View>
      <Text
        style={{
          marginLeft: space.md,
          fontSize: 15,
          fontFamily: fonts.body,
          color: destructive ? colors.red : colors.ink,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ChatLongPressSheet(): React.ReactElement {
  const colors = useTheme();
  const row = useSheetStore((s) => s.row);
  const page = useSheetStore((s) => s.page);
  const close = useSheetStore((s) => s.close);
  const setPage = useSheetStore((s) => s.setPage);
  const visible = row !== null;
  if (!row) {
    return <Modal visible={false} transparent animationType="fade" />;
  }
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={{ flex: 1, backgroundColor: colors.shade }} onPress={close}>
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: colors.paperRaised,
            borderTopLeftRadius: radii.lg,
            borderTopRightRadius: radii.lg,
            paddingTop: space.md,
            paddingBottom: space.xl,
          }}
        >
          <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
            <Text
              style={{
                ...typography.title,
                fontSize: 18,
                color: colors.ink,
              }}
            >
              {row.name ?? row.chatId}
            </Text>
          </View>
          {page === 'rename' ? (
            <RenamePage row={row} onDone={close} />
          ) : (
            <>
              {isHidden(row) && (
                <Item
                  icon={<Eye size={18} color={colors.ink2} />}
                  label="Show chat"
                  onPress={() => {
                    close();
                    showHiddenChat(row.chatId);
                  }}
                />
              )}
              {!isReservedSpecialThread(row.chatId) && (
                <Item
                  icon={<Pencil size={18} color={colors.ink2} />}
                  label="Rename chat"
                  onPress={() => setPage('rename')}
                />
              )}
              <Item
                icon={<Pin size={18} color={colors.ink2} />}
                label={row.pinned ? 'Unpin chat' : 'Pin chat'}
                onPress={() => {
                  close();
                  togglePin(row);
                }}
              />
              {/* Special threads cannot be snoozed (spec/04 § Snooze) — the
                  daemon rejects it, so the phone does not offer it. */}
              {!isReservedSpecialThread(row.chatId) &&
                (isSnoozed(row) ? (
                  <Item
                    icon={<AlarmClockOff size={18} color={colors.ink2} />}
                    label="Unsnooze chat"
                    onPress={() => {
                      close();
                      applySnooze(row.chatId, null);
                    }}
                  />
                ) : (
                  <Item
                    icon={<AlarmClock size={18} color={colors.ink2} />}
                    label="Snooze chat"
                    onPress={() => {
                      close();
                      showChatSnoozeSheet(row);
                    }}
                  />
                ))}
              {!isReservedSpecialThread(row.chatId) &&
                row.status === 'active' &&
                !isHidden(row) && (
                  <Item
                    icon={<EyeOff size={18} color={colors.ink2} />}
                    label="Hide chat"
                    onPress={() => {
                      close();
                      hideChat(row.chatId);
                    }}
                  />
                )}
              <Item
                icon={
                  row.status === 'archived' ? (
                    <PackageOpen size={18} color={colors.ink2} />
                  ) : (
                    <Archive size={18} color={colors.ink2} />
                  )
                }
                label={row.status === 'archived' ? 'Unarchive chat' : 'Archive chat'}
                onPress={() => {
                  close();
                  toggleArchive(row);
                }}
              />
              <Item
                icon={<Mic size={18} color={colors.ink2} />}
                label="Send voice note"
                onPress={() => {
                  close();
                  startVoiceNote(row.chatId);
                }}
              />
              <Item
                icon={<Trash2 size={18} color={colors.red} />}
                label="Delete chat"
                destructive
                onPress={() => {
                  close();
                  deleteChatRow(row);
                }}
              />
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
