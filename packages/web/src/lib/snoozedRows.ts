// Snoozed chats into the store. The active-inbox snapshot leaves them out, but
// the sidebar draws a snoozed project's chats as one line inside the project
// (spec/04 § Snooze), so they are loaded at cold start as well as when the
// Snoozed section opens.

import type { PermissionMode, SnoozeRecord } from '@patch/wire';
import type { ChatRow } from '../stores/types.js';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';

interface SnoozedApiRow {
  chatId: string;
  name: string | null;
  preview: string | null;
  folder: string;
  activity: 'idle' | 'running' | 'awaiting-permission' | 'errored';
  status: 'active' | 'archived' | 'errored' | 'deleted';
  pinned: boolean;
  pinnedAt: number | null;
  snoozedUntil: number | null;
  snoozeRecords?: SnoozeRecord[];
  runningSince?: number | null;
  hidden?: boolean;
  lastUpdated: number;
  hostId: string;
  permissionMode: PermissionMode;
  jobId: string | null;
}

/** A `GET /api/chats?snoozed=only` row as `chatStore.mergeChats` takes it. */
export function snoozedRowsForStore(chats: unknown[]): Array<
  Partial<ChatRow> & {
    chatId: string;
    name: string | null;
    hostId: string;
    folder: string;
    activity: ChatRow['activity'];
    permissionMode: PermissionMode;
    status: ChatRow['status'];
    pinned: boolean;
    pinnedAt: number | null;
    disabled: boolean;
    lastUpdated: number;
    jobId: string | null;
    snoozedUntil: number | null;
  }
> {
  return (chats as SnoozedApiRow[]).map((c) => ({
    chatId: c.chatId,
    name: c.name,
    preview: c.preview,
    hostId: c.hostId,
    permissionMode: c.permissionMode,
    folder: c.folder,
    activity: c.activity,
    status: c.status,
    pinned: c.pinned,
    pinnedAt: c.pinnedAt,
    disabled: false,
    snoozedUntil: c.snoozedUntil,
    ...(c.snoozeRecords ? { snoozeRecords: c.snoozeRecords } : {}),
    ...(c.runningSince !== undefined ? { runningSince: c.runningSince } : {}),
    hidden: c.hidden ?? false,
    lastUpdated: c.lastUpdated,
    jobId: c.jobId,
  }));
}

/** Fold every snoozed chat into the store, a page at a time. */
export async function loadSnoozedChats(): Promise<void> {
  let offset = 0;
  for (;;) {
    const page = await api.listChatsSnoozed({ limit: 200, offset });
    useChatStore.getState().mergeChats(snoozedRowsForStore(page.chats));
    if (page.nextOffset === null) return;
    offset = page.nextOffset;
  }
}
