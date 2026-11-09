// "Group by status" for the Chats tab — mirrors packages/web/src/lib/chatGroups.ts's
// `groupByStatus` and `SIDEBAR_GROUPINGS` so the phone and the desktop sidebar
// bucket and order chats identically (spec/15 § Chats tab → Grouping).

import { deriveBadge, type ChatRow } from '../stores/types';
import { matchesStateFilter } from './stateFilter';

export type SidebarGrouping = 'project' | 'status';

export const SIDEBAR_GROUPINGS: ReadonlyArray<{ value: SidebarGrouping; label: string }> = [
  { value: 'project', label: 'Group by project' },
  { value: 'status', label: 'Group by status' },
];

export const DEFAULT_SIDEBAR_GROUPING: SidebarGrouping = 'project';

export interface StatusGroup {
  key: string;
  label: string;
  rows: ChatRow[];
}

const STATUS_GROUP_DEFS: ReadonlyArray<Pick<StatusGroup, 'key' | 'label'>> = [
  { key: 'status:failed', label: 'Failed' },
  { key: 'status:waiting', label: 'Waiting on you' },
  { key: 'status:ready', label: 'Ready to review' },
  { key: 'status:working', label: 'Working' },
  { key: 'status:done', label: 'Done' },
];

/**
 * Re-bucket rows by status: Failed, Waiting on you, Ready to review (finished,
 * unread), Working, Done (finished, read). Each row lands in exactly one bucket,
 * driven off the same `deriveBadge` as the row's own icon; empty buckets are
 * dropped and rows keep the order they arrived in.
 */
export function groupByStatus(rows: readonly ChatRow[]): StatusGroup[] {
  const buckets = new Map<string, ChatRow[]>(STATUS_GROUP_DEFS.map((d) => [d.key, []]));
  for (const row of rows) {
    const key = matchesStateFilter(row, 'failed')
      ? 'status:failed'
      : matchesStateFilter(row, 'waiting')
        ? 'status:waiting'
        : matchesStateFilter(row, 'working')
          ? 'status:working'
          : deriveBadge(row) === 'done'
            ? 'status:ready'
            : 'status:done';
    buckets.get(key)?.push(row);
  }
  return STATUS_GROUP_DEFS.map((d) => ({ ...d, rows: buckets.get(d.key) ?? [] })).filter(
    (g) => g.rows.length > 0,
  );
}
