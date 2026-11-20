// What the user's agents are currently waiting on (spec/14 § Waiting view).
//
// Two kinds of wait, both already durable and owned by Patch rather than by a
// running turn:
//   - time: the chat's pending self-wake / loop (`patch_wake_me`, `patch_loop`)
//   - event: an enabled one-off job whose action messages that chat — the agent
//     said "tell me when this trigger fires" and ended its turn.
// Pure derivation over what the client already holds, so it has no fetch of its own.

import type { Job } from '@patch/wire/jobs';
import type { ChatRow } from '../stores/types.js';
import { describeTrigger } from './jobDescribe.js';

export type WaitingRow =
  | {
      kind: 'time';
      key: string;
      chatId: string;
      /** What the host will deliver back into the chat. */
      message: string;
      fireAt: number;
      every?: number;
      /** A loop tick absorbed because the chat is mid-turn: fireAt is stale. */
      held: boolean;
    }
  | {
      kind: 'event';
      key: string;
      chatId: string;
      jobId: string;
      jobName: string;
      /** The trigger in words, e.g. "Webhook" or "Todoist task tagged …". */
      trigger: string;
      createdAt: number;
    };

function isLive(chat: ChatRow | undefined): chat is ChatRow {
  return chat !== undefined && chat.status !== 'archived' && chat.status !== 'deleted';
}

export function deriveWaiting(
  chats: Record<string, ChatRow>,
  jobs: readonly Job[],
  viewerTimeZone?: string,
): WaitingRow[] {
  const rows: WaitingRow[] = [];
  for (const chat of Object.values(chats)) {
    const w = chat.pendingWake;
    if (!w || !isLive(chat)) continue;
    rows.push({
      kind: 'time',
      key: `wake:${chat.chatId}`,
      chatId: chat.chatId,
      message: w.message,
      fireAt: w.fireAt,
      ...(w.every !== undefined ? { every: w.every } : {}),
      held: w.waiting === true,
    });
  }
  for (const job of jobs) {
    if (!job.oneOff || !job.enabled || job.archived || job.expiredAt !== undefined) continue;
    if (job.action.type !== 'message') continue;
    const chatId = job.action.chatId;
    if (!isLive(chats[chatId])) continue;
    rows.push({
      kind: 'event',
      key: `job:${job.id}`,
      chatId,
      jobId: job.id,
      jobName: job.name,
      trigger: describeTrigger(job.trigger, viewerTimeZone),
      createdAt: job.createdAt,
    });
  }
  // Soonest timer first, then events newest first.
  const t = (r: WaitingRow): number => (r.kind === 'time' ? r.fireAt : Infinity);
  return rows.sort((a, b) =>
    a.kind === 'time' && b.kind === 'time'
      ? t(a) - t(b)
      : a.kind !== b.kind
        ? a.kind === 'time'
          ? -1
          : 1
        : (b as { createdAt: number }).createdAt - (a as { createdAt: number }).createdAt,
  );
}
