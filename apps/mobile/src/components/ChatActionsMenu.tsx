// ChatActionsMenu — the chat-detail header's ⋯ button and the anchored menu it
// opens (spec/15 § Chat detail). The items come from `chatKebabItems`
// (lib/chatActions); this component owns what each one does:
//
// - New chat opens the type-first new-chat screen already set to THIS chat's
//   folder on THIS chat's host — the web header's New chat, "another one
//   here". Nothing is created until the first send (spec/15 § New chat flow).
//   A special thread's folder is its own private working dir, not a project,
//   so from one the screen opens on its usual default.
// - Find in chat opens the header's find bar (the `onFind` prop).
// - Terminal opens the host terminal in this chat's folder.
// - Tools pushes the full-screen per-chat tools page (app/chats/[chatId]/tools).
// - Files pushes the chat-folder document browser (app/chats/[chatId]/docs).
// - Add tasks (only while the chat has no list) summons the task bar, open.
// - Move to… pushes the Move page (app/chats/[chatId]/move): another host,
//   and the folder the chat will run in there.
// - Show / Pin / Snooze / Archive call the very functions the Chats-tab row
//   tools call.
// - Disable / Enable is the special-thread off switch, same route as web.
// - Clear context retires the special thread's session and starts fresh with
//   a handoff digest, same route as web (spec/06 § Session rotation).
// - Delete (last, red) removes the chat and returns to the list.

import React, { useState, type ReactElement } from 'react';
import { Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import {
  Archive,
  ArchiveRestore,
  BellOff,
  BellRing,
  Eraser,
  Eye,
  FolderInput,
  Folder,
  ListPlus,
  MessageSquarePlus,
  MoreHorizontal,
  Pin,
  PinOff,
  Power,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  Trash2,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react-native';
import { isReservedSpecialThread } from '@patch/wire';
import { AnchoredMenu } from './AnchoredMenu';
import {
  showChatSnoozeSheet,
  applySnooze,
  showHiddenChat,
  toggleArchive,
} from './ChatLongPressSheet';
import { chatKebabItems } from '../lib/chatActions';
import { docsRoute } from '../lib/docEditor';
import { terminalRoute } from '../lib/hostFiles';
import { clearContext, toggleDisabled } from '../lib/chatMeta';
import { useReadAloud } from '../lib/readAloud';
import { api } from '../api/rest';
import { useChatStore } from '../stores/chatStore';
import { useUiStore } from '../stores/uiStore';
import { isHidden, isSnoozed, type ChatRow } from '../stores/types';
import { space, useTheme } from '../lib/theme';
import { markLeavingForArchive } from '../lib/leaveArchived';

/** The route of a chat's full-screen Tools page. */
export function chatToolsRoute(chatId: string): `/chats/${string}/tools` {
  return `/chats/${chatId}/tools`;
}

const MENU_ICONS: Record<string, LucideIcon> = {
  'New chat': MessageSquarePlus,
  'Find in chat': Search,
  'Read everything aloud': Volume2,
  'Stop reading everything': VolumeX,
  Tools: SlidersHorizontal,
  Files: Folder,
  Terminal: SquareTerminal,
  'Add tasks': ListPlus,
  Enable: Power,
  Disable: Power,
  'Clear context': Eraser,
  'Show chat': Eye,
  'Pin chat': Pin,
  'Unpin chat': PinOff,
  'Snooze chat': BellOff,
  'Unsnooze chat': BellRing,
  'Archive chat': Archive,
  'Unarchive chat': ArchiveRestore,
  'Move to…': FolderInput,
  'Delete chat': Trash2,
};

export function ChatActionsMenu({
  chatId,
  row,
  onFind,
}: {
  chatId: string;
  row: ChatRow | undefined;
  onFind: () => void;
}): ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const readAll = useReadAloud((s) => s.readAll);

  const items = chatKebabItems(chatId, {
    pinned: row?.pinned ?? false,
    snoozed: row !== undefined && isSnoozed(row),
    archived: row?.status === 'archived',
    hidden: row !== undefined && isHidden(row),
    disabled: row?.disabled ?? false,
    noTasks: row !== undefined && row.todos.length === 0,
    readAll,
  }).map((label) => ({
    id: label,
    label,
    icon: MENU_ICONS[label],
    destructive: label === 'Delete chat',
  }));

  const newChatHere = (): void => {
    if (isReservedSpecialThread(chatId)) {
      router.push('/new-chat');
      return;
    }
    // No fallback to the picker: a chat whose host is not known yet (not yet
    // spawned) has no "here" to start another in, and saying so is honest.
    if (!row || row.hostId === '' || row.folder === '') {
      useUiStore.getState().pushError("new chat failed: this chat's host isn't known yet");
      return;
    }
    router.push({
      pathname: '/new-chat',
      params: { hostId: row.hostId, folder: row.folder },
    });
  };

  // AnchoredMenu dismisses itself before calling this.
  const onSelect = (id: string): void => {
    switch (id) {
      case 'New chat':
        newChatHere();
        return;
      case 'Read everything aloud':
      case 'Stop reading everything':
        useReadAloud.getState().setReadAll(!readAll);
        return;
      case 'Find in chat':
        onFind();
        return;
      case 'Terminal':
        if (!row || row.hostId === '' || row.folder === '') {
          useUiStore.getState().pushError("terminal failed: this host isn't known yet");
          return;
        }
        router.push(terminalRoute(row.hostId, row.folder));
        return;
      case 'Tools':
        router.push(chatToolsRoute(chatId));
        return;
      case 'Files':
        router.push(docsRoute(chatId));
        return;
      case 'Add tasks':
        useUiStore.getState().setTaskAddChatId(chatId);
        return;
      case 'Move to…':
        router.push(`/chats/${chatId}/move`);
        return;
      case 'Disable':
      case 'Enable':
        void toggleDisabled(chatId);
        return;
      case 'Clear context':
        void clearContext(chatId);
        return;
      case 'Delete chat':
        void api.deleteChat(chatId);
        useChatStore.getState().removeChat(chatId);
        router.back();
        return;
      case 'Archive chat':
      case 'Unarchive chat':
        // Archiving takes the chat off the active list, so go back to it, as
        // Delete does; unarchiving keeps the user in the chat just restored.
        if (!row) return;
        if (id === 'Archive chat') markLeavingForArchive(chatId);
        toggleArchive(row);
        if (id === 'Archive chat') router.back();
        return;
      case 'Show chat':
        // Showing moves the chat into the active list; the user stays in it.
        showHiddenChat(chatId);
        return;
      case 'Snooze chat':
        if (row) showChatSnoozeSheet(row);
        return;
      case 'Unsnooze chat':
        applySnooze(chatId, null);
        return;
      case 'Pin chat':
      case 'Unpin chat': {
        const pinned = !(row?.pinned ?? false);
        useChatStore.getState().setPinned(chatId, pinned);
        void api.pinChat(chatId, pinned);
        return;
      }
      default:
        throw new Error(`unknown chat menu item: ${id}`);
    }
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={{ padding: space.sm }}
        accessibilityRole="button"
        accessibilityLabel="More"
      >
        <MoreHorizontal size={22} color={colors.ink} />
      </Pressable>
      <AnchoredMenu
        visible={open}
        items={items}
        onSelect={onSelect}
        onDismiss={() => setOpen(false)}
      />
    </>
  );
}
