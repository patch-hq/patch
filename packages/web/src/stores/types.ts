// Shared store types.
//
// Per spec/14-design-web.md sidebar status badges + chat lifecycle. A chat's
// status is the server's (`chatStatus`, spec/05 § Chat status): the surface
// stores it with its row and displays it, and never works one out itself.

import type {
  ChatContextUsage,
  ChatStateEvent,
  ChatStatus,
  EffortLevel,
  FinishedGoal,
  GoalProgress,
  PendingWake,
  PermissionMode,
  ReminderEvery,
  SnoozeRecord,
  StatusKind,
  TodoItem,
} from '@patch/wire';

export interface ChatRow {
  chatId: string;
  name: string | null;
  /**
   * The host this chat is pinned to (`chat.spawned`), fixed for its life.
   * Empty only for a row the surface created optimistically before the
   * host's `chat.spawned` reconciled it — every host-scoped action on the
   * chat refuses while it is empty rather than guessing a host.
   */
  hostId: string;
  folder: string;
  /** The effective permission mode the chat's next turn will use (`chat.state`). */
  permissionMode: PermissionMode;
  status: ChatStatus;
  pinned: boolean;
  pinnedAt: number | null;
  /** A special thread turned off (spec/06 § Disabled). `false` for ordinary chats. */
  disabled: boolean;
  lastUpdated: number;
  /**
   * ms epoch of the user's own last activity on this chat — when they last
   * sent a message, or chat creation if they never have (spec/14 § Sidebar
   * ordering). `chatGroups.ts` sorts Pinned and Folders rows by this instead
   * of `lastUpdated`, so an agent reply, a status change, a job tick or a
   * finished turn never moves a row.
   */
  lastUserActivity: number;
  /** ms epoch the chat was created; absent until the host reports it. The Created sort key. */
  createdAt?: number;
  /**
   * spec/04 § Provider switches, § Moving to another host — the chat this one
   * continues, and the chat that continues it. Server-owned; absent on a chat
   * with no link. The list shows a thread once, as its newest chat.
   */
  continuedFrom?: string;
  continuedIn?: string;
  /** Set when this chat is awaiting a permission decision. */
  awaitingPermission: boolean;
  /**
   * Local-only: the highest per-chat `seq` the user had seen the last time they
   * opened this chat. Drives unread vs read. We track read state by SEQ, not by
   * wall-clock, because opening a chat triggers a history read that re-delivers
   * the chat's history — those replayed events carry their ORIGINAL (≤ current)
   * seqs, so a seq-based watermark is immune to replay. A wall-clock model is
   * not: replayed messages would bump a `lastUpdated` to "now" and perpetually
   * out-run any visit timestamp, so the chat could never settle to `read`.
   *
   * Initialised to `-1` (nothing seen) so a freshly-hydrated chat — whose true
   * `seq` we don't yet know from the REST cold-start — reads as unread until the
   * user actually visits it. `seq` is always `>= 0` for real stream items.
   */
  lastReadSeq: number;
  /**
   * Durable first-user-message snippet — the sidebar one-line label for a row
   * (used for archived rows, which carry no live timeline). Captured ONCE from
   * the first user message and never overwritten by later turns, so the label
   * stays stable instead of flipping as a turn streams.
   */
  preview: string | null;
  /**
   * The chat's goal (patch/todo.md — `/goal`). Shown in a banner at the top of
   * the chat. `null` when no goal is set.
   */
  goal: string | null;
  /** Live progress on the active goal (spec/04 § Goals). `null` iff `goal` is `null`. */
  goalProgress: GoalProgress | null;
  /** The most recently finished goal (spec/04 § Goals), kept after `goal` clears. */
  lastGoal: FinishedGoal | null;
  /** Goals that start in order once the active one is met (spec/04 § Goals — sequence). */
  goalQueue?: string[];
  /** How often the active goal is restated to the agent; `null`/absent = never. */
  goalReminderEvery?: ReminderEvery | null;
  /** How often the evaluator is asked whether the goal is on track; `null` = never. */
  goalCheckInEvery?: ReminderEvery | null;
  /**
   * The chat's reminder (patch/todo.md — Reminders). A configurable reminder to
   * do / not do something, shown in a banner at the top of the chat. `null` when
   * no reminder is set.
   */
  reminder: string | null;
  /** How often the reminder is re-injected into the agent; `null` = banner only. */
  reminderEvery?: ReminderEvery | null;
  /**
   * The chat's pending self-wake (spec/02 § Self-wake) — the message the host
   * will deliver back into this chat, and when. Drives the wake bar above the
   * chat (patch/todo.md — "cron should be visible in a bar above the chat,
   * showing how long until next wakeup and the prompt"). `null` when nothing is
   * armed; clears when the wake fires or is cancelled.
   */
  pendingWake: PendingWake | null;
  /**
   * The chat's task list (spec/02 § Task list), mirrored from the agent's native
   * TodoWrite and editable from here. Drives the task bar above the transcript.
   * Empty until the agent writes a list.
   */
  todos: TodoItem[];
  /**
   * Auto-generated one-line "current status" summary of the thread and any
   * action it needs (patch/todo.md § Features to add — "Current status"). Shown
   * nested under the sidebar row. `null` until the host generates one.
   */
  statusSummary: string | null;
  /**
   * Whether the thread is paused on a user `question` or simply `complete`
   * (stopped, nothing outstanding). Drives the sidebar's distinct treatment of
   * the two. `null` until a summary lands.
   */
  statusKind: StatusKind | null;
  /**
   * Whether `statusKind` is a real declared status (`patch_ask_human` /
   * `patch_surface`) rather than a generated one-shot's guess. Only a declared
   * `question` outranks the read/unread check in `deriveBadge` — a generated
   * guess is a frequent false positive (any reply containing a `?`) and must
   * not freeze the row indigo forever. `null`/`false` for a generated status
   * or when nothing has landed.
   */
  statusDeclared: boolean | null;
  /**
   * ms epoch this chat is snoozed until (spec/04 § Snooze), or `null` when it
   * is not snoozed. Snoozed ⇔ `snoozedUntil > Date.now()` — derived at render
   * time, so a snooze that lapses while the app is open simply comes back.
   */
  snoozedUntil: number | null;
  /**
   * What each snooze of the chat was and what happened in it (spec/04 § Snooze),
   * oldest first. Drives the Back state and the transcript divider. Optional
   * like `hidden`; absent is none.
   */
  snoozeRecords?: SnoozeRecord[];
  /** ms epoch the chat's current run began; `null`/absent when it is not running. */
  runningSince?: number | null;
  /**
   * Running out of the active list (spec/04 § Hidden), from `chat.state`. A
   * separate axis from `status`, like `snoozedUntil`: the chat is drawn hidden
   * only while it is also `active` (`isHidden`) — an archived chat may keep the
   * flag and is drawn as archived.
   *
   * Optional like `backgroundTasks`, so the row fixtures that say nothing about
   * it do not all have to declare it; `emptyRow` sets it. Absent is not hidden,
   * which is also what the wire's absent field means.
   */
  hidden?: boolean;
  /**
   * Known only from a `chat.spawned` frame, with no `chat.state` or snapshot
   * yet. A host re-announces every chat it holds on (re)connect, archived and
   * hidden ones included, as `chat.spawned` then `chat.state`; until the state
   * lands the row's status is a default, not a fact, so the sidebar leaves it
   * out (`groupChats`) rather than drawing an archived chat as active for one
   * batch. Absent or false is settled.
   */
  awaitingState?: boolean;
  /** Pending permission requests (unanswered). */
  pendingPermissions: PendingPermission[];
  /** Highest seq we've seen — the cursor history reads catch up from. */
  lastSeq: number;
  /**
   * The job whose `spawn` action created this chat (spec/08 § Action), or
   * `null` for a chat a user/surface started. Server-populated, set once at
   * spawn time and never changed — drives the sidebar's `▸ Automations`
   * group (spec/14 § Sidebar), which is an ADDITIONAL, always-current view
   * onto whichever job-spawned chats exist, not a chat mover: this field
   * never moves a chat out of wherever else it also sits (active/archived/
   * snoozed).
   */
  jobId: string | null;
  /**
   * The chat whose `patch_spawn` created this one, from `chat.spawned`; absent
   * for a chat a person or a job started. Drives the "Started by" banner.
   */
  parentChatId?: string;
  /** The parent's name as the host knew it at spawn; used when the parent is not in the local store. */
  parentChatName?: string;
  /**
   * The model this chat is running on: what it spawned with (`chat.spawned`),
   * then whatever a later change made it (`chat.state`, spec/04 § Model). Shown
   * in the header's folder crumb, which is also the control that changes it.
   * `null` when the chat's host has no model catalogue support configured to
   * report one — a `null` here is "not known", never a model.
   */
  model: string | null;
  /**
   * The Claude thinking-effort override this chat is running at (spec/04 §
   * Effort), mirrored the same way `model` is. `null` when no override is set
   * or the chat is on the Codex backend — either way there is nothing to show
   * beyond the picker reading "Default".
   */
  effort: EffortLevel | null;
  /**
   * ms-epoch when this chat's rate-limit auto-resume is scheduled, or `null`
   * when no retry is pending. Surfaced by the host when `autoResumeRateLimit`
   * is on and a turn was blocked by a usage/rate-limit error. Shown above the
   * composer as "paused — resuming at HH:MM".
   */
  rateLimitResumingAt: number | null;
  /**
   * Distinguishes the pause reason when `rateLimitResumingAt` is set:
   * `'rate_limit'` for a 429/usage-limit block (shows "Usage limit — paused");
   * `'overloaded'` for a transient 529 (shows "Server busy — paused"). `null`
   * when no resume is pending. Optional for back-compat with older hosts.
   */
  resumeKind: 'rate_limit' | 'overloaded' | null;
  /** Since when the turn has been held for its host to wake fully; `null` when not held. */
  waitingForWakeSince?: number | null;
  /**
   * Why the chat is blocked, in figures — which account, which pool, how full,
   * when it clears. `null` when it is not blocked.
   *
   * Carried separately from the provider's sentence on purpose. "You've hit
   * your monthly spend limit · your session limit resets 9:40am (UTC)" names
   * two different limits, states a time in a zone the reader is not in, and
   * says nothing about which of several accounts it is talking about — and it
   * was the only thing a surface had to show.
   *
   * Optional rather than required so the two dozen existing row fixtures do not
   * all have to declare a field they say nothing about; `emptyRow` sets it, so
   * every row the app actually builds carries it.
   */
  limitBlock?: ChatStateEvent['limitBlock'] | null;
  /**
   * What releases the pause (`chat.state.limitNext`, spec/12 § A usage or rate
   * limit): the host by itself, the user choosing a provider, or the user
   * pressing Continue. `null` when nothing is paused.
   */
  limitNext?: ChatStateEvent['limitNext'] | null;
  /** Credit is back for a chat that stopped for it; the card offers Continue. */
  creditReturned?: boolean;
  /** Why the chat's last turn failed (`chat.state` while errored); `null` otherwise. */
  lastError?: ChatStateEvent['lastError'] | null;
  /**
   * The account the chat's latest turn ran on (`chat.state`, spec/10 § Backend
   * credentials). Null until a turn has run on the host holding the chat.
   */
  account?: { id: string; label: string } | null;
  /**
   * The shared account the chat's turns START on (`chat.state`); null is "by
   * strategy". Undefined until a host that knows the field has said.
   */
  preferredAccountId?: string | null;
  /**
   * How many of this chat's backgrounded commands and sub-agents are still
   * RUNNING, as the host counted them (`chat.state`, spec/02 § Background
   * task completions). Drives the sidebar's `background` badge.
   *
   * `null` is UNKNOWN and is never rendered as anything: a host that predates
   * the field reports nothing, and a row that has not yet heard a state frame
   * knows nothing either. `0` is the positive claim that nothing is running.
   * The distinction is the whole point — drawing "nothing running" from silence
   * is the guess this field exists to avoid (spec/12 — NO FALLBACK).
   *
   * Optional like `limitBlock`, so the row fixtures that say nothing about it do
   * not all have to declare it; `emptyRow` sets it, so every row the app
   * actually builds carries it.
   */
  backgroundTasks?: number | null;
  /**
   * The running `patch_delegate` sub-agent share of `backgroundTasks` (the
   * rest are `patch_watch` tasks). Same unknown-is-not-zero rule.
   */
  runningAgents?: number | null;
  /**
   * The chat's status as the server decided it (spec/05 § Chat status). The
   * only status a surface shows; absent until the server's first word on the
   * chat, and then no status is shown rather than an assumed one.
   */
  chatStatus?: import('@patch/wire').ChatStatusInfo;
  /**
   * `callId`s of this chat's open tool calls (one array entry per outstanding
   * call, pushed on `chat.tool_call`, removed on its `chat.tool_result`,
   * cleared on stop/idle), so a single call's own row can ask "is MY call
   * still open" instead of "is the chat working on something". Never read as
   * the chat's status. Without this a call's row fell back to a chat-wide
   * check, which is also true for a LATER call in a promoted turn —
   * so a tool call the user had already cancelled kept showing a live spinner
   * and ticking elapsed time for as long as the chat went on being busy with
   * something else entirely.
   */
  openCallIds?: string[];
  /**
   * How full the chat's context window is (spec/14 § Composer — context ring).
   * `null`/absent means nothing measured, which draws no ring — not an empty one.
   */
  context?: ChatContextUsage | null;
  /**
   * Claude Code's OWN provider-level context this chat has received
   * (`chat.provider_context`, spec/02 § Provider-level context) — environment,
   * model identity, token counts, and the rest of Claude Code's native
   * `type: "attachment"` entries, as distinct from Patch's own five
   * hand-injected `<system-reminder>` builders (`ChatEventEntry.systemContext`
   * below).
   *
   * Keyed by `providerType` (Claude Code's own stable name, e.g.
   * `"environment"`), because these recur constantly within a session — one
   * ROW per category, not one per occurrence, upserted to the latest
   * label/text with a running count (ProviderContextPanel renders this).
   * Optional like `backgroundTasks`, so fixtures that don't care about it
   * don't all have to declare it; `emptyRow` sets `{}` for every row the app
   * actually builds.
   */
  providerContext?: Record<string, ProviderContextEntry>;
}

/** One category's latest state in `ChatRow.providerContext` — see there. */
export interface ProviderContextEntry {
  label: string;
  text: string;
  /** How many `chat.provider_context` events of this `providerType` have
   *  landed — the deduplication this exists for, made visible rather than
   *  silently discarding every occurrence but the last. */
  count: number;
  /** The seq of the FIRST occurrence — stable sort key, so a row's position
   *  in the panel doesn't jump every time it updates. */
  firstSeq: number;
  /** The seq of the latest occurrence applied — the replay-dedup guard
   *  (`chatStore.ts`), same idea as every other seq-keyed upsert here. */
  lastSeq: number;
}

export interface PendingPermission {
  requestId: string;
  tool: string;
  description: string | undefined;
  args: unknown;
}

export type DisplayBadge =
  | 'working'
  | 'permission'
  | 'errored'
  | 'interrupted'
  | 'signin'
  | 'done'
  | 'paused'
  | 'away'
  | 'agents'
  | 'background'
  | 'monitoring'
  | 'read';

/** The chat's status as the server sent it, or undefined before its first word. */
export function statusOf(row: { chatStatus?: { state: string } } | undefined): string | undefined {
  return row?.chatStatus?.state;
}

/** The server says a turn is in flight on this chat. */
export function isRunning(row: { chatStatus?: { state: string } } | undefined): boolean {
  return statusOf(row) === 'running';
}

/**
 * Whether the Stop control belongs on the composer. A chat parked only on the
 * agent's own question is waiting for the user, not working, so there is
 * nothing to stop; an approval (a turn paused mid-work) still can be stopped.
 */
export function isStoppable(row: Pick<ChatRow, 'chatStatus' | 'pendingPermissions'>): boolean {
  const state = statusOf(row);
  if (state === 'running') return true;
  if (state !== 'waiting_for_user') return false;
  const pending = row.pendingPermissions;
  return pending.length > 0 && pending.some((p) => p.tool !== 'AskUserQuestion');
}

/**
 * The badge for a row, per spec/14 § Status badges. What the chat is doing is
 * the server's status alone (spec/05 § Chat status); the surface adds only its
 * own read mark and the quiet work the server reports alongside it.
 */
export function deriveBadge(row: ChatRow): DisplayBadge {
  const server = statusOf(row);
  if (server === 'waiting_for_user') return 'permission';
  if (server === 'failed') return 'errored';
  if (server === 'interrupted') return 'interrupted';
  if (server === 'waiting_for_sign_in') return 'signin';
  if (server === 'running') return 'working';
  if (row.lastSeq > row.lastReadSeq) return 'done';
  if (server === 'paused') return 'paused';
  if (server === 'host_offline' || server === 'host_restarting' || server === 'queued_offline') {
    return 'away';
  }
  // NO FALLBACK: only a POSITIVE count is background work; `null` is "nobody
  // measured". Agents win over plain tasks, as they are the ones that talk back.
  if (typeof row.runningAgents === 'number' && row.runningAgents > 0) return 'agents';
  if (typeof row.backgroundTasks === 'number' && row.backgroundTasks > 0) return 'background';
  if (row.pendingWake) return 'monitoring';
  return 'read';
}

/** spec/04 § Snooze — a chat is snoozed only while its wake time is still ahead. */
export function isSnoozed(row: { snoozedUntil: number | null }, now: number = Date.now()): boolean {
  return row.snoozedUntil !== null && row.snoozedUntil > now;
}

/**
 * spec/04 § Hidden — drawn in the Hidden section, and nowhere else, while it is
 * active OR errored. A background job does not stop being hidden merely because
 * it failed. Archived/deleted lifecycle states still take precedence.
 */
export function isHidden(row: { status: ChatStatus; hidden?: boolean }): boolean {
  return row.status !== 'archived' && row.status !== 'deleted' && row.hidden === true;
}

/**
 * One row of the server's folder roster (`GET /api/chats/folders`, spec/04
 * § Folders → Folder roster): a folder holding at least one non-deleted chat —
 * ARCHIVED INCLUDED — on `hostId`, stamped with its most-recent chat's
 * `lastUpdated`.
 *
 * Lives here rather than in `chatGroups.ts` because `chatGroups` already
 * imports from the store; defining it there and importing it back would be a
 * cycle.
 */
export interface FolderRosterEntry {
  folder: string;
  hostId: string;
  lastUpdated: number;
}

/**
 * The server's section counts (`GET /api/chats/counts`, spec/04 § Section
 * counts): how many chats each collapsed sidebar section holds. Each number is
 * the length of that section's own list query, so the badge on a collapsed row
 * and the rows drawn on expanding it always agree.
 */
export interface SectionCounts {
  hidden: number;
  archived: number;
  snoozed: number;
  deleted: number;
  automations: number;
}

/** What surrounds a goal when it is set from a surface (spec/04 § Goals). */
export interface GoalPlan {
  then?: string[];
  remindEvery?: ReminderEvery | null;
  checkInEvery?: ReminderEvery | null;
}
