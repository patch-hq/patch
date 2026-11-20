// Server-side cache of chat state, populated by `chat.spawned` + `chat.state`
// events from the host. Drives REST endpoints like `GET /api/chats` so HTTP
// surfaces (CLI cold-start, mobile pull-to-refresh) don't need a live WS.
//
// This is a thin mirror — the host remains the source of truth for a chat's
// work, but the server OWNS what it last knew: the mirror is written to
// `<dataDir>/chat-registry.json` as it changes and read back at startup, so a
// restart begins from what the server knew rather than from nothing. A chat
// restored this way is unconfirmed until its host reports it again; when a
// host closes its re-announcement (`folders.list`), a restored chat of that
// host that it did not report is dropped, so a chat deleted while the server
// was down does not linger.
//
// Phantom-row gating (group 8 / DX-M1): a `chat.state` event for a chatId
// the registry has never seen `chat.spawned` for is dropped (with a warn).
// Without this, a `setPinned` / `setArchived` rejection that nevertheless
// emits a chat.state would synthesise a row from thin air. `chat.error` with
// a spawn-time code (`folder_not_found`) tears the row down — the spawn
// failed, the row should not exist.

import { parsePersisted } from './persisted-json.js';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Logger } from 'pino';
import {
  deriveStatus,
  emptyFacts,
  factsFromHostState,
  factsOnRequestRaised,
  factsOnHeldResolved,
  factsOnRequestResolved,
  factsOnTurnEnded,
  factsOnTurnStarted,
  isAllowedTransition,
  isMidTurn,
  legacyActivity,
  nextStatus,
  restoredFacts,
  type ChatStatusFacts,
} from './chat-status.js';
import type {
  ChatErrorCode,
  ChatStateEvent,
  ChatStatusInfo,
  EffortLevel,
  PendingWake,
  TodoItem,
  PermissionMode,
  StatusKind,
  WireEvent,
  ChatContextUsage,
  GoalProgress,
  FinishedGoal,
  ReminderEvery,
  ChatBranch,
} from '@patch/wire';
import { isReservedSpecialThread, type SnoozeRecord } from '@patch/wire';

export interface ChatSummary {
  chatId: string;
  name: string | null;
  /**
   * One-line snippet of the first user message (G2-d4). Lets the sidebar label
   * unnamed/archived rows distinctly even when several share a folder basename.
   * Null until the first user turn lands.
   */
  preview: string | null;
  /**
   * One-line snippet of the chat's latest user/assistant message and the host's
   * high-water seq, mirrored from `chat.state`. They let the roster (REST) carry
   * what the phone otherwise learns only from a live subscription. Optional: a
   * row from before the fields, or from an older host, has neither.
   */
  lastMessagePreview?: string | null;
  lastSeq?: number;
  /**
   * The chat's goal (patch/todo.md — `/goal`), mirrored from the host's
   * `chat.state`. `null` when unset. Lets REST surfaces show the goal at the top
   * of the chat on cold-start without waiting for a live WS.
   */
  goal: string | null;
  /** Live progress on the chat's active goal, mirrored from the host's `chat.state`. */
  goalProgress: GoalProgress | null;
  /** Goals that start in order once the active one is met, mirrored from `chat.state`. */
  goalQueue: string[];
  goalReminderEvery: ReminderEvery | null;
  goalCheckInEvery: ReminderEvery | null;
  /** The chat's most recently finished goal, mirrored from the host's `chat.state`. */
  lastGoal: FinishedGoal | null;
  /**
   * The chat's reminder (patch/todo.md — Reminders), mirrored from the host's
   * `chat.state`. `null` when unset. Lets REST surfaces show the reminder at the
   * top of the chat on cold-start without waiting for a live WS.
   */
  reminder: string | null;
  /**
   * The chat's auto-generated one-line status summary and its kind, mirrored
   * from the host's `chat.state`. `null` until one is generated. The Manager
   * watch loop reports it as the human-readable half of a watch event, and the
   * Manager view's Threads strip renders it per row (`01-server.md`
   * § Responsibilities, `14-design-web.md` § Manager view).
   */
  statusSummary: string | null;
  statusKind: StatusKind | null;
  /**
   * Whether `statusKind` is declared (a real `patch_ask_human`/`patch_report`
   * call) rather than a generated guess — see `wire/events.ts` § statusDeclared.
   */
  statusDeclared: boolean | null;
  /**
   * The chat's pending self-wake (spec/02 § Self-wake), mirrored from the
   * host's `chat.state`. `null` when nothing is armed. Lets a surface render
   * the wake bar on cold-start instead of waiting for the next live `chat.state`.
   */
  pendingWake: PendingWake | null;
  /**
   * The chat's task list (spec/02 § Task list), mirrored from the host's
   * `chat.state`. Empty until the agent writes one. Lets a surface render the
   * task bar on cold-start instead of waiting for the next live `chat.state`.
   */
  todos: TodoItem[];
  /**
   * The host this chat is pinned to, from `chat.spawned`, and changed only by
   * moving the chat (`rehome`). The mirror records it because routing a surface event to a chat's
   * host needs to know which one owns it, and REST callers list chats
   * grouped by host.
   */
  hostId: string;
  /**
   * The EFFECTIVE permission mode the chat's next turn will use, as the host
   * resolved it. Mirrored, never re-derived: the server does not know the
   * host's default and would have to guess (spec/02 § Permission mode).
   */
  permissionMode: PermissionMode;
  folder: string;
  /**
   * The server's status said the old way, for readers that predate
   * `chatStatus` (`chat-status.ts` § legacyActivity). Never a host's word.
   */
  activity: 'idle' | 'running' | 'awaiting-permission' | 'errored';
  status: 'active' | 'archived' | 'errored' | 'deleted';
  pinned: boolean;
  /**
   * ms epoch when the chat was last pinned. Drives sidebar ordering: pinned
   * chats sort by `pinnedAt` desc (most-recent-pinned at top per spec/04).
   */
  pinnedAt: number | null;
  /**
   * A special thread turned off (spec/06 § Disabled), mirrored from the
   * host's `chat.state`. Only meaningful for Manager/Speakers —
   * `false` for every ordinary chat.
   */
  disabled: boolean;
  /**
   * ms epoch the chat is snoozed until (spec/04 § Snooze), or `null` when it is
   * not snoozed. Snoozed ⇔ `snoozedUntil > now`, so a lapsed snooze needs no
   * event to bring the chat back into the active list.
   */
  snoozedUntil: number | null;
  /** What each snooze was and what happened in it (spec/04 § Snooze), oldest first. */
  snoozeRecords: SnoozeRecord[];
  /** ms epoch the current run began, or `null` when not running. */
  runningSince: number | null;
  /**
   * Running out of the active list (spec/04 § Hidden), mirrored from the
   * host's `chat.state`. Drawn only in the sidebar's Hidden section.
   */
  hidden: boolean;
  lastUpdated: number;
  /**
   * ms epoch of the user's own last activity on this chat, mirrored from the
   * host's `chat.state` (spec/14 § Sidebar ordering). Drives sidebar
   * ordering instead of `lastUpdated` — an agent reply, a status change, a
   * job tick or a finished turn never moves it. Falls back to `lastUpdated`
   * when a host predating the field omits it, which is no worse than the
   * sort behaviour before this field existed.
   */
  lastUserActivity: number;
  /** ms epoch the chat was created, when the host reports it (sidebar Created sort). */
  createdAt?: number;
  /**
   * The job whose `spawn` action created this chat (spec/08 § Action), or
   * `null` for a chat a user/surface spawned. Looked up from the injected
   * `jobChatLinks` at `chat.spawned` time — never from the wire event itself,
   * since an old host has no notion of jobs and never sends one. Drives the
   * sidebar's Automations group (spec/14 § Sidebar).
   */
  jobId: string | null;
  /**
   * spec/04 § Provider switches, § Moving to another host — the chat this one
   * continues, and the chat that continues it. Server-owned: recorded by
   * `linkContinuation` when a linked chat is spawned, never from a host frame,
   * so every merge carries them forward. Absent on a chat with no link.
   */
  continuedFrom?: string;
  continuedIn?: string;
  /**
   * The model this chat is running on: what it resolved to at spawn (spec/04 §
   * Spawn), kept in step with any later change by the `model` the host
   * carries on `chat.state` (spec/04 § Model). `null` when the spawning host
   * had no model catalogue support configured (an older host, or a minimal
   * test one) — it spawned the chat without one to report.
   */
  model: string | null;
  /**
   * The Claude thinking-effort override this chat is running at (spec/04 §
   * Effort), mirrored from `chat.state`. `null` means either no override is
   * set or the chat is on the Codex backend — same as the host's own
   * `ChatStateEvent.effort`, since a cold-start surface cannot tell the two
   * apart from this alone and doesn't need to: either way there is no
   * override to show.
   */
  effort: EffortLevel | null;
  /**
   * How many of this chat's backgrounded commands and sub-agents are still
   * running, as the host reported on `chat.state` (spec/02 § Background task
   * completions). Mirrored so a surface that cold-starts over REST knows a chat
   * is still working before the next live state frame — that frame only comes
   * when something changes, so without this a reload would show the finished
   * tick on a chat with work in flight for as long as the work took.
   *
   * `null` means UNKNOWN, and is not `0`: a host that predates the field
   * never reports one, and a surface must draw no background state at all
   * rather than claim nothing is running (spec/12 — NO FALLBACK).
   */
  backgroundTasks: number | null;
  /** The running sub-agent share of `backgroundTasks`; `null` is unknown. */
  runningAgents: number | null;
  /**
   * Why the chat is `errored`, mirrored from the host's `chat.state`. Held here
   * so a surface that cold-starts from REST (a reload, a reconnect) can still
   * say what failed instead of a bare "Failed". `null` whenever the chat is not
   * errored.
   */
  lastError: { code: string; message: string; at: number } | null;
  /**
   * How full the chat's context window is, as the host last reported on
   * `chat.state` (spec/14 § Composer — context ring). Mirrored for the same
   * cold-start reason as `backgroundTasks`. `null` means nothing measured.
   */
  context: ChatContextUsage | null;
  /** Latest host-reported branch graph, retained for server-copy takeover. */
  branches: ChatBranch[];
  activeBranchId: string | null;
  /**
   * The chat's status as this server derives it (spec/12 § Chat status).
   * Optional only so a registry file written before it existed still loads.
   */
  chatStatus?: ChatStatusInfo;
  /** Where this row last changed in the account feed (spec/03 § Account feed). */
  feedPos?: number;
}

export interface ChatRegistryOptions {
  logger?: Pick<Logger, 'warn'>;
  /** Injectable clock — snooze filtering compares `snoozedUntil` against it. */
  now?: () => number;
  /**
   * Server-owned chatId → jobId map (`jobs/chat-links.ts`), consulted on
   * `chat.spawned` to tag a job-spawned chat's row. Absent → every chat's
   * `jobId` is `null` (no automations, e.g. tests that don't need them).
   */
  jobChatLinks?: { get(chatId: string): string | null };
  /**
   * Where the chat index is kept between runs (`<dataDir>/chat-index.jsonl`):
   * one line appended per changed chat. Absent keeps it in memory only, as a
   * bare-registry test wants.
   */
  persistPath?: string;
  /**
   * The whole-file mirror older servers wrote (`<dataDir>/chat-registry.json`).
   * Read once when there is no index yet, then deleted at the next write.
   */
  legacyPath?: string;
}

/** How long a change waits before the mirror is written, so a burst is one write. */
const PERSIST_DELAY_MS = 1_000;

/** Superseded lines the index may carry past two per chat before it is rewritten. */
const COMPACT_SLACK_LINES = 1_000;

/** How far past a slot's start a host's own report must be before an idle chat counts as having worked. */
export const WORK_EVIDENCE_MS = 10_000;

/** Spawn-time error codes that should remove the chat from the registry. */
const SPAWN_TIME_ERROR_CODES = new Set<ChatErrorCode>(['folder_not_found']);

export class ChatRegistry {
  private readonly chats = new Map<string, ChatSummary>();
  /** chatIds we've observed `chat.spawned` for. Gates `chat.state` admission. */
  private readonly spawnedSet = new Set<string>();
  /**
   * Hosts whose full chat list this mirror holds. Empty at server start: a
   * host re-announces every chat right after `auth.ok` and closes that burst
   * with `folders.list`, so once its `folders.list` has been observed, a chat
   * this mirror does not know is not on that host.
   */
  private readonly syncedHosts = new Set<string>();
  private readonly logger: Pick<Logger, 'warn'> | undefined;
  private readonly now: () => number;
  private readonly jobChatLinks: { get(chatId: string): string | null } | undefined;
  private readonly persistPath: string | null;
  private readonly legacyPath: string | null;
  /** The row object last written for each chat. Rows are replaced, never edited, so a different object means a change. */
  private written = new Map<string, ChatSummary>();
  private writtenWorked = new Map<string, number>();
  /** Lines now in the index file, superseded ones included. */
  private indexLines = 0;
  private persistTimer: NodeJS.Timeout | null = null;
  /** Chats read back from disk that no host has reported since this process started. */
  private readonly unconfirmed = new Set<string>();
  /** When each chat was last seen working (running, or waiting on a permission). Saved with the mirror. */
  private readonly workedAt = new Map<string, number>();
  /** The account feed's latest position: one more each time a row changes. */
  private feedCounter = 0;
  /** What the server knows of each chat, from which its status is derived (`chat-status.ts`). Saved with the mirror. */
  private readonly facts = new Map<string, ChatStatusFacts>();
  private writtenFacts = new Map<string, ChatStatusFacts>();
  /** Work the server itself holds for a chat (the message queue). */
  private owed: (chatId: string) => boolean = () => false;
  /** Told of every status change a fact made that no host `chat.state` carries. */
  private readonly statusListeners = new Set<(event: ChatStateEvent) => void>();
  /** The latest turn details each chat's host reported, carried on the server's own frames. */
  private readonly turnDetails = new Map<
    string,
    Pick<ChatStateEvent, 'turnOrigin' | 'turnStopped' | 'turnSummary'>
  >();
  /** Frames the event gate has already applied, so the event tap does not apply them twice. */
  private readonly gated = new WeakSet<object>();

  constructor(opts: ChatRegistryOptions = {}) {
    this.logger = opts.logger;
    this.now = opts.now ?? (() => Date.now());
    this.jobChatLinks = opts.jobChatLinks;
    this.persistPath = opts.persistPath ?? null;
    this.legacyPath = opts.legacyPath ?? null;
    this.restore();
  }

  /**
   * Append what changed since the last write and return. One line per changed
   * chat, so a change costs the size of one row however many chats there are.
   * Call on shutdown.
   */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.persistPath === null) return;
    try {
      const lines: string[] = [];
      for (const [chatId, row] of this.chats) {
        if (this.written.get(chatId) !== row) lines.push(JSON.stringify({ c: row }));
      }
      for (const chatId of this.written.keys()) {
        if (!this.chats.has(chatId)) lines.push(JSON.stringify({ x: chatId }));
      }
      for (const [chatId, at] of this.workedAt) {
        if (this.writtenWorked.get(chatId) !== at) lines.push(JSON.stringify({ w: [chatId, at] }));
      }
      for (const [chatId, f] of this.facts) {
        if (this.writtenFacts.get(chatId) !== f) lines.push(JSON.stringify({ f: [chatId, f] }));
      }
      if (lines.length > 0) {
        appendFileSync(this.persistPath, lines.join('\n') + '\n');
        this.indexLines += lines.length;
        this.written = new Map(this.chats);
        this.writtenWorked = new Map(this.workedAt);
        this.writtenFacts = new Map(this.facts);
      }
      if (this.legacyPath && existsSync(this.legacyPath)) unlinkSync(this.legacyPath);
      if (this.indexLines > this.chats.size * 2 + COMPACT_SLACK_LINES) this.compact();
    } catch (err) {
      this.logger?.warn({ err }, 'chat-registry: could not write the chat index');
    }
  }

  /** Rewrite the index as one line per live chat, dropping the superseded ones. */
  private compact(): void {
    if (this.persistPath === null) return;
    const tmp = `${this.persistPath}.tmp`;
    const lines: string[] = [];
    for (const row of this.chats.values()) lines.push(JSON.stringify({ c: row }));
    for (const [chatId, at] of this.workedAt) lines.push(JSON.stringify({ w: [chatId, at] }));
    for (const [chatId, f] of this.facts) lines.push(JSON.stringify({ f: [chatId, f] }));
    writeFileSync(tmp, lines.length > 0 ? lines.join('\n') + '\n' : '');
    renameSync(tmp, this.persistPath);
    this.indexLines = lines.length;
  }

  private markDirty(): void {
    if (this.persistPath === null || this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.flush(), PERSIST_DELAY_MS);
    this.persistTimer.unref();
  }

  private adopt(chat: ChatSummary): void {
    if (typeof chat?.chatId !== 'string' || chat.chatId === '') return;
    this.chats.set(chat.chatId, chat);
    this.spawnedSet.add(chat.chatId);
    this.unconfirmed.add(chat.chatId);
    if ((chat.feedPos ?? 0) > this.feedCounter) this.feedCounter = chat.feedPos!;
  }

  private restore(): void {
    if (this.persistPath === null) return;
    try {
      if (existsSync(this.persistPath)) {
        const lines = readFileSync(this.persistPath, 'utf8').split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        lines.forEach((line, i) => {
          let entry: {
            c?: ChatSummary;
            x?: string;
            w?: [string, number];
            f?: [string, ChatStatusFacts];
          };
          try {
            entry = parsePersisted(line) as typeof entry;
          } catch (err) {
            // A crash mid-append leaves one torn line, and only ever the last.
            if (i === lines.length - 1) {
              this.logger?.warn(
                { err },
                'chat-registry: skipped a torn last line of the chat index',
              );
              return;
            }
            throw err;
          }
          if (entry.c) this.adopt(entry.c);
          else if (typeof entry.x === 'string') {
            this.chats.delete(entry.x);
            this.spawnedSet.delete(entry.x);
            this.unconfirmed.delete(entry.x);
            this.workedAt.delete(entry.x);
            this.facts.delete(entry.x);
          } else if (Array.isArray(entry.w) && typeof entry.w[1] === 'number') {
            this.workedAt.set(entry.w[0], entry.w[1]);
          } else if (Array.isArray(entry.f) && typeof entry.f[1] === 'object') {
            this.facts.set(entry.f[0], restoredFacts(entry.f[1]));
          }
        });
        this.indexLines = lines.length;
        // Once per start, drop every superseded line.
        if (this.indexLines > this.chats.size + this.workedAt.size + this.facts.size) {
          this.compact();
        }
      } else if (this.legacyPath && existsSync(this.legacyPath)) {
        const parsed = parsePersisted(readFileSync(this.legacyPath, 'utf8')) as {
          chats?: ChatSummary[];
          worked?: Record<string, number>;
        };
        for (const [chatId, at] of Object.entries(parsed.worked ?? {})) {
          if (typeof at === 'number') this.workedAt.set(chatId, at);
        }
        for (const chat of parsed.chats ?? []) this.adopt(chat);
        // Write the whole index now; the old file goes at the first flush.
        this.compact();
      }
      this.written = new Map(this.chats);
      this.writtenWorked = new Map(this.workedAt);
      this.writtenFacts = new Map(this.facts);
    } catch (err) {
      // NO FALLBACK: say so, then start empty rather than guess at a damaged file.
      this.chats.clear();
      this.spawnedSet.clear();
      this.unconfirmed.clear();
      this.workedAt.clear();
      this.facts.clear();
      this.logger?.warn(
        { err },
        'chat-registry: could not read the saved chat index; starting empty',
      );
    }
  }

  /**
   * Look at a host frame before any other reader does (the host link's event
   * gate). The facts it carries are applied here, and a host's `chat.state` is
   * passed on with the server's status on it, so every reader downstream sees
   * the status the server decided and never one a host concluded.
   */
  gate(event: WireEvent): WireEvent {
    this.observe(event);
    let out: WireEvent = event;
    if (event.type === 'chat.state') {
      const row = this.chats.get(event.chatId);
      if (row) {
        // Whatever a host put in these is not the server's word, so it goes.
        const { activity: _activity, lastError: _lastError, chatStatus: _status, ...facts } = event;
        void _activity;
        void _lastError;
        void _status;
        out = {
          ...facts,
          activity: row.activity,
          ...(row.chatStatus ? { chatStatus: row.chatStatus } : {}),
          ...(row.feedPos !== undefined ? { feedPos: row.feedPos } : {}),
          ...(row.lastError ? { lastError: row.lastError as ChatStateEvent['lastError'] } : {}),
        };
      }
    }
    this.gated.add(out);
    return out;
  }

  /** A frame the gate passed on in a changed form: already applied, so the tap skips it. */
  markGated(event: WireEvent): void {
    this.gated.add(event);
  }

  /** Work the server itself holds for a chat keeps it running between turns. */
  setOwedWork(owed: (chatId: string) => boolean): void {
    this.owed = owed;
  }

  /**
   * Hear every status change a fact made on its own (a turn boundary, a
   * question): there is no host `chat.state` to carry those, so the caller
   * sends this one to surfaces.
   */
  onStatusChange(listener: (event: ChatStateEvent) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** The facts the status is derived from, for tests and diagnostics. */
  factsOf(chatId: string): ChatStatusFacts | undefined {
    return this.facts.get(chatId);
  }

  /**
   * Work the status out again after something outside the host's frames
   * changed (the server's queue emptied). Tells the listeners when it moved.
   */
  recompute(chatId: string): void {
    const facts = this.facts.get(chatId);
    if (facts) this.applyFacts(chatId, facts, { tell: true, own: true });
  }

  observe(event: WireEvent): void {
    if (this.gated.has(event)) return;
    // A batched replay carries events this would otherwise have seen one by
    // one (spec/12 § Sequence-based replay). Unpack it so asking for batches
    // changes only HOW MANY FRAMES cross the link, never what the mirror is
    // told — there is no `forSurfaceId` guard here, so replayed events have
    // always reached this, and quietly dropping them with batching on would
    // be a difference nobody asked for.
    if (event.type === 'chat.replay_batch') {
      for (const inner of event.events) this.observe(inner as WireEvent);
      return;
    }
    if (event.type === 'folders.list') {
      this.syncedHosts.add(event.hostId);
      // The host has finished telling us what it has: a restored chat of this
      // host that it did not mention is not on it any more.
      let pruned = false;
      // The host announces in full only the chats it has loaded; `chatIds` names
      // the rest it still holds, which the server keeps as it restored them.
      const held = event.chatIds === undefined ? undefined : new Set(event.chatIds);
      for (const chatId of [...this.unconfirmed]) {
        if (this.chats.get(chatId)?.hostId !== event.hostId) continue;
        this.unconfirmed.delete(chatId);
        if (held?.has(chatId)) continue;
        this.chats.delete(chatId);
        this.spawnedSet.delete(chatId);
        this.facts.delete(chatId);
        pruned = true;
      }
      if (pruned) this.markDirty();
    }
    if (event.type === 'chat.spawned') {
      this.spawnedSet.add(event.chatId);
      this.unconfirmed.delete(event.chatId);
      const existing = this.chats.get(event.chatId);
      if (existing) return; // chat.state will keep it fresh
      this.markDirty();
      this.chats.set(event.chatId, {
        chatId: event.chatId,
        name: null,
        preview: null,
        goal: null,
        goalProgress: null,
        goalQueue: [],
        goalReminderEvery: null,
        goalCheckInEvery: null,
        lastGoal: null,
        reminder: null,
        statusSummary: null,
        statusKind: null,
        statusDeclared: null,
        pendingWake: null,
        todos: [],
        hostId: event.hostId,
        permissionMode: 'auto',
        folder: event.folder,
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        snoozedUntil: null,
        snoozeRecords: [],
        runningSince: null,
        hidden: false,
        lastUpdated: 0,
        lastUserActivity: 0,
        jobId: this.jobChatLinks?.get(event.chatId) ?? null,
        model: event.model ?? null,
        effort: null,
        lastError: null,
        // Nothing has reported on this chat's background work yet — unknown,
        // which is not the same as none.
        backgroundTasks: null,
        runningAgents: null,
        context: null,
        branches: [],
        activeBranchId: null,
        chatStatus: { state: 'idle', since: this.now() },
        feedPos: ++this.feedCounter,
      });
      if (!this.facts.has(event.chatId)) this.facts.set(event.chatId, emptyFacts());
      return;
    }
    if (event.type === 'chat.turn_started' || event.type === 'chat.turn_ended') {
      if (!this.chats.has(event.chatId)) return;
      const prev = this.facts.get(event.chatId) ?? emptyFacts();
      const next =
        event.type === 'chat.turn_started'
          ? factsOnTurnStarted(prev, event.turnId)
          : factsOnTurnEnded(prev, event.turnId, event.outcome, event.error);
      if (event.type === 'chat.turn_started') this.workedAt.set(event.chatId, this.now());
      this.applyFacts(event.chatId, next, { tell: true });
      return;
    }
    // The host took a message the server held for it, or refused it (spec/12 §
    // Chat status): it is no longer queued for an offline host. An ack the
    // server's own queue makes for one surface is not the host's.
    if (
      (event.type === 'chat.input_ack' &&
        typeof (event as { forSurfaceId?: unknown }).forSurfaceId !== 'string') ||
      (event.type === 'chat.error' && event.rejectedLocalId !== undefined)
    ) {
      const localId = event.type === 'chat.input_ack' ? event.localId : event.rejectedLocalId!;
      const prev = this.facts.get(event.chatId);
      if (!prev || !this.chats.has(event.chatId)) return;
      const next = factsOnHeldResolved(prev, localId);
      if (next !== prev) this.applyFacts(event.chatId, next, { tell: true, own: true });
      return;
    }
    if (event.type === 'patch.browser_handoff.state') {
      // The agent waiting for the user to take over a tab is blocked on them as
      // an approval is; a shared view for review blocks nothing.
      if (event.shared === true || !this.chats.has(event.chatId)) return;
      const prev = this.facts.get(event.chatId) ?? emptyFacts();
      const id = `handoff:${event.handoffId}`;
      const next =
        event.status === 'waiting'
          ? factsOnRequestRaised(prev, id, 'browser_handoff')
          : factsOnRequestResolved(prev, id);
      if (JSON.stringify(next) !== JSON.stringify(prev)) {
        this.applyFacts(event.chatId, next, { tell: true });
      }
      return;
    }
    if (event.type === 'chat.permission_request' || event.type === 'chat.permission_response') {
      // A request replayed to one surface is history, not a new fact.
      if (typeof (event as { forSurfaceId?: unknown }).forSurfaceId === 'string') return;
      const chatId = event.chatId;
      if (chatId === undefined || !this.chats.has(chatId)) return;
      const prev = this.facts.get(chatId) ?? emptyFacts();
      const next =
        event.type === 'chat.permission_request'
          ? factsOnRequestRaised(prev, event.requestId, event.request.tool)
          : factsOnRequestResolved(prev, event.requestId);
      this.applyFacts(chatId, next, { tell: true });
      return;
    }
    if (event.type === 'chat.branches') {
      const chat = this.chats.get(event.chatId);
      if (!chat) return;
      this.chats.set(event.chatId, {
        ...chat,
        branches: event.branches,
        activeBranchId: event.activeBranchId,
      });
      this.markDirty();
      return;
    }
    if (event.type === 'chat.state') {
      if (!this.spawnedSet.has(event.chatId)) {
        // No prior chat.spawned — refuse to fabricate a row. Group 8 fix
        // (DX-M1): without this gate, a host-side rejected pin/archive
        // could still drive a row into existence.
        this.logger?.warn(
          { chatId: event.chatId, type: 'chat.state' },
          'chat-registry: ignoring chat.state for unspawned chat',
        );
        return;
      }
      const existing = this.chats.get(event.chatId);
      const next: ChatSummary = {
        chatId: event.chatId,
        name: event.name ?? existing?.name ?? null,
        // Preview is captured once and never cleared: prefer the incoming value
        // but never let an absent/undefined event field wipe a known preview.
        preview: event.preview ?? existing?.preview ?? null,
        // The latest message CAN be absent, so only an ABSENT field (older host)
        // keeps the known value; the seq only ever moves forward.
        lastMessagePreview:
          event.lastMessagePreview !== undefined
            ? event.lastMessagePreview
            : (existing?.lastMessagePreview ?? null),
        lastSeq: Math.max(existing?.lastSeq ?? 0, event.lastSeq ?? 0),
        // Goal CAN be cleared (set to null), so `null` is a meaningful value —
        // only fall back to the existing goal when the field is absent (undefined).
        goal: event.goal !== undefined ? event.goal : (existing?.goal ?? null),
        goalProgress:
          event.goalProgress !== undefined ? event.goalProgress : (existing?.goalProgress ?? null),
        lastGoal: event.lastGoal !== undefined ? event.lastGoal : (existing?.lastGoal ?? null),
        goalQueue: event.goalQueue !== undefined ? event.goalQueue : (existing?.goalQueue ?? []),
        goalReminderEvery:
          event.goalReminderEvery !== undefined
            ? event.goalReminderEvery
            : (existing?.goalReminderEvery ?? null),
        goalCheckInEvery:
          event.goalCheckInEvery !== undefined
            ? event.goalCheckInEvery
            : (existing?.goalCheckInEvery ?? null),
        // Reminder CAN be cleared (set to null), so `null` is meaningful — only
        // fall back to the existing reminder when the field is absent (undefined).
        reminder: event.reminder !== undefined ? event.reminder : (existing?.reminder ?? null),
        // A status summary CAN clear, so `null` is meaningful — only keep the
        // existing value when the field is absent (undefined).
        statusSummary:
          event.statusSummary !== undefined
            ? event.statusSummary
            : (existing?.statusSummary ?? null),
        statusKind:
          event.statusKind !== undefined ? event.statusKind : (existing?.statusKind ?? null),
        statusDeclared:
          event.statusDeclared !== undefined
            ? event.statusDeclared
            : (existing?.statusDeclared ?? null),
        // A pending wake CAN clear (fired / cancelled), so `null` is meaningful —
        // only keep the existing value when the field is absent (undefined).
        pendingWake:
          event.pendingWake !== undefined ? event.pendingWake : (existing?.pendingWake ?? null),
        // The task list CAN empty (the agent completed it, or the user deleted
        // every item), so `[]` is meaningful — only keep the existing list when
        // the field is absent (undefined).
        todos: event.todos !== undefined ? event.todos : (existing?.todos ?? []),
        hostId: existing?.hostId ?? event.hostId ?? '',
        permissionMode: event.permissionMode,
        folder: event.folder ?? existing?.folder ?? '',
        activity: existing?.activity ?? 'idle',
        status: event.status ?? existing?.status ?? 'active',
        pinned: event.pinned ?? existing?.pinned ?? false,
        // Unpinning sends `null`, which is meaningful — only keep the existing
        // value when the field is absent (undefined).
        pinnedAt: event.pinnedAt !== undefined ? event.pinnedAt : (existing?.pinnedAt ?? null),
        disabled: event.disabled ?? existing?.disabled ?? false,
        // A snooze CAN clear (unsnoozed / woken), so `null` is meaningful — only
        // keep the existing value when the field is absent (undefined).
        snoozedUntil:
          event.snoozedUntil !== undefined ? event.snoozedUntil : (existing?.snoozedUntil ?? null),
        snoozeRecords: event.snoozeRecords ?? existing?.snoozeRecords ?? [],
        runningSince:
          event.runningSince !== undefined ? event.runningSince : (existing?.runningSince ?? null),
        hidden: event.hidden ?? existing?.hidden ?? false,
        lastUpdated: event.lastUpdated,
        // Back-compat: an older host never sends the field, so fall back to
        // the last known value and, failing that, to `lastUpdated` — no worse
        // than the sort behaviour before this field existed. `||`, not `??`:
        // the `chat.spawned` row seeds this at `0` as a placeholder (same as
        // `lastUpdated`), and `0` is never a real epoch — falling through to
        // `lastUpdated` the first time a real `chat.state` lands (even one
        // omitting the field) is what we want, and `??` would treat that
        // placeholder `0` as a known value and get stuck on it.
        lastUserActivity: event.lastUserActivity || existing?.lastUserActivity || event.lastUpdated,
        ...((event.createdAt ?? existing?.createdAt) !== undefined
          ? { createdAt: (event.createdAt ?? existing?.createdAt) as number }
          : {}),
        // jobId is set once, at spawn time, and never changes — chat.state
        // carries no jobId field, so it always just carries the existing value
        // forward.
        jobId: existing?.jobId ?? null,
        // Server-owned links (spec/04 § Provider switches): a host never sends them.
        ...(existing?.continuedFrom !== undefined ? { continuedFrom: existing.continuedFrom } : {}),
        ...(existing?.continuedIn !== undefined ? { continuedIn: existing.continuedIn } : {}),
        // spec/04 § Model — a chat's model CAN change mid-chat, and `chat.state`
        // is how the change travels, so take the event's value when it carries
        // one. Absence means "unchanged" (an older host never sends the
        // field), not "no model", so the existing value is carried forward
        // rather than being wiped to null.
        model: event.model !== undefined ? event.model : (existing?.model ?? null),
        // spec/04 § Effort — same absent-means-unchanged rule as `model`.
        effort: event.effort !== undefined ? event.effort : (existing?.effort ?? null),
        // spec/02 § Background task completions. `0` is meaningful (the last
        // task finished), so only an ABSENT field carries the known value
        // forward — a host too old to count them must not be read as
        // reporting none.
        backgroundTasks:
          event.backgroundTasks !== undefined
            ? event.backgroundTasks
            : (existing?.backgroundTasks ?? null),
        runningAgents:
          event.runningAgents !== undefined
            ? event.runningAgents
            : (existing?.runningAgents ?? null),
        context: event.context !== undefined ? event.context : (existing?.context ?? null),
        lastError: existing?.lastError ?? null,
        branches: existing?.branches ?? [],
        activeBranchId: existing?.activeBranchId ?? null,
        ...(existing?.chatStatus ? { chatStatus: existing.chatStatus } : {}),
        feedPos: ++this.feedCounter,
      };
      this.chats.set(event.chatId, next);
      this.unconfirmed.delete(event.chatId);
      this.turnDetails.set(event.chatId, {
        ...(event.turnOrigin !== undefined ? { turnOrigin: event.turnOrigin } : {}),
        ...(event.turnStopped !== undefined ? { turnStopped: event.turnStopped } : {}),
        ...(event.turnSummary !== undefined ? { turnSummary: event.turnSummary } : {}),
      });
      const facts = factsFromHostState(this.facts.get(event.chatId) ?? emptyFacts(), event);
      // This frame is the host's own word for the chat; it reaches surfaces itself.
      this.applyFacts(event.chatId, facts, { tell: false });
      this.markDirty();
      return;
    }
    if (event.type === 'chat.stopped') {
      if (!this.spawnedSet.has(event.chatId)) {
        this.logger?.warn(
          { chatId: event.chatId, type: 'chat.stopped' },
          'chat-registry: ignoring chat.stopped for unspawned chat',
        );
        return;
      }
      // No-op for now; the host emits chat.state with the new activity.
      return;
    }
    if (event.type === 'chat.error') {
      // Spawn-time errors mean the chat never came into existence — clear
      // any phantom row and forget the spawn marker.
      if (SPAWN_TIME_ERROR_CODES.has(event.error.code)) {
        this.chats.delete(event.chatId);
        this.spawnedSet.delete(event.chatId);
        this.facts.delete(event.chatId);
        this.markDirty();
      }
      return;
    }
  }

  /**
   * Seed the registry from the host's snapshot. Called once on server
   * startup so REST surfaces don't see an empty list while the host's
   * chat_state is in fact populated. Each entry is treated as a fully-
   * spawned chat (the host wouldn't return it otherwise).
   */
  seed(snapshot: Iterable<ChatSummary>): void {
    for (const c of snapshot) {
      this.spawnedSet.add(c.chatId);
      this.unconfirmed.delete(c.chatId);
      this.chats.set(c.chatId, c);
    }
    this.markDirty();
  }

  get(chatId: string): ChatSummary | undefined {
    return this.chats.get(chatId);
  }

  /**
   * Has this chat done work since `since`? A chat is reported idle before its
   * first turn starts, so an idle chat is only known to be FINISHED if there is
   * evidence it worked. Two kinds count:
   *
   *   - the mirror saw it working after `since` (kept across restarts), or
   *   - failing that, its host reports it idle with a first message accepted and
   *     its own clock well past `since`: a turn that has been accepted and
   *     started runs at once, so one still at rest that long afterwards has run.
   *     This covers a chat that finished while the server was down, or before
   *     this was kept.
   */
  hasWorkedSince(chatId: string, since: number): boolean {
    if ((this.workedAt.get(chatId) ?? -1) >= since) return true;
    const chat = this.chats.get(chatId);
    if (!chat || chat.preview === null) return false;
    return chat.lastUpdated >= since + WORK_EVIDENCE_MS;
  }

  /** Whether this host has re-announced its chats since the server started. */
  hasSynced(hostId: string): boolean {
    return this.syncedHosts.has(hostId);
  }

  /**
   * Store a chat's facts and derive its status from them (spec/12 § Chat
   * status). Returns the chat's `chat.state` when anything a surface draws
   * moved, and tells the status listeners when `tell` is set. A change outside
   * the allowed transitions is applied and logged as a fault, unless it is the
   * server's own (`own`), which only ever makes allowed ones.
   */
  private applyFacts(
    chatId: string,
    facts: ChatStatusFacts,
    opts: { tell: boolean; own?: boolean },
  ): ChatStateEvent | null {
    this.facts.set(chatId, facts);
    this.markDirty();
    const row = this.chats.get(chatId);
    if (!row) return null;
    const owed = this.owed(chatId);
    const target = deriveStatus(facts, owed);
    const prev = row.chatStatus;
    if (prev && opts.own !== true && !isAllowedTransition(prev.state, target.state)) {
      this.logger?.warn(
        { chatId, from: prev.state, to: target.state },
        'chat-registry: a status change outside the allowed transitions',
      );
    }
    const chatStatus = nextStatus(prev ?? null, target, this.now());
    const activity = legacyActivity(facts, owed);
    const lastError = lastErrorOf(facts, row.lastError, chatStatus.since);
    if (
      JSON.stringify(prev) === JSON.stringify(chatStatus) &&
      activity === row.activity &&
      JSON.stringify(lastError) === JSON.stringify(row.lastError)
    ) {
      return null;
    }
    const next: ChatSummary = {
      ...row,
      chatStatus,
      activity,
      lastError,
      feedPos: ++this.feedCounter,
    };
    this.chats.set(chatId, next);
    const event = this.stateEventOf(next);
    if (opts.tell) {
      for (const listener of this.statusListeners) {
        try {
          listener(event);
        } catch (err) {
          this.logger?.warn({ err, chatId }, 'chat-registry: a status listener threw');
        }
      }
    }
    return event;
  }

  /**
   * The server holds a message for this chat's offline host (spec/12 § Chat
   * status). Returns the `chat.state` to broadcast, or null when the chat is
   * unknown or its status does not change for it (a chat mid-turn keeps its own).
   */
  markQueued(chatId: string, localId: string): ChatStateEvent | null {
    const existing = this.chats.get(chatId);
    if (!existing) return null;
    const facts = this.facts.get(chatId) ?? emptyFacts();
    const from = existing.chatStatus?.state ?? 'idle';
    if (facts.held.includes(localId)) return null;
    const held = [...facts.held, localId];
    // Another message behind one already held: remembered, the status unchanged.
    if (from === 'queued_offline') {
      this.applyFacts(chatId, { ...facts, held }, { tell: false, own: true });
      return null;
    }
    if (!isAllowedTransition(from, 'queued_offline')) return null;
    return this.applyFacts(chatId, { ...facts, held }, { tell: false, own: true });
  }

  /**
   * A host left the account: nothing the server held for it will be
   * delivered. Returns the `chat.state` of each chat that changed.
   */
  dropHeldForHost(hostId: string): ChatStateEvent[] {
    const events: ChatStateEvent[] = [];
    for (const [chatId, row] of this.chats) {
      const facts = this.facts.get(chatId);
      if (row.hostId !== hostId || !facts || facts.held.length === 0) continue;
      const event = this.applyFacts(chatId, { ...facts, held: [] }, { tell: false, own: true });
      if (event) events.push(event);
    }
    return events;
  }

  /**
   * A host went (spec/12 § Chat status): announced (`restarting`) or not
   * (`offline`). Each of its chats with a turn in flight or a question open
   * reads Host restarting or Host offline until the host speaks for it again;
   * a chat with nothing running keeps its status. Returns the `chat.state` of
   * each chat that changed, for the caller to broadcast.
   */
  markHostAway(hostId: string, how: 'restarting' | 'offline'): ChatStateEvent[] {
    const events: ChatStateEvent[] = [];
    for (const [chatId, row] of this.chats) {
      if (row.hostId !== hostId) continue;
      const facts = this.facts.get(chatId);
      if (!facts) continue;
      const working = isMidTurn(facts) || facts.away !== null;
      // A restart that ran out of time becomes offline; offline never goes back to restarting.
      if (!working || facts.away === how || (how === 'restarting' && facts.away === 'offline')) {
        continue;
      }
      const event = this.applyFacts(chatId, { ...facts, away: how }, { tell: false, own: true });
      if (event) events.push(event);
    }
    return events;
  }

  /** chatIds on this host with a turn in flight or a question open. */
  midTurnChatIds(hostId: string): string[] {
    const ids: string[] = [];
    for (const [chatId, row] of this.chats) {
      const facts = this.facts.get(chatId);
      if (row.hostId === hostId && facts && isMidTurn(facts)) ids.push(chatId);
    }
    return ids;
  }

  /**
   * A message the server held for this chat's offline host expired undelivered
   * (spec/12 § Host-offline UX). The chat reads failed, with the reason and the
   * words, until a turn starts in it again. This is the server's own fact, and
   * the one way a chat goes from `queued_offline` to `failed`. Returns the
   * `chat.state` to broadcast, or null for a chat the registry does not know.
   */
  markHeldExpired(chatId: string, message: string, localId?: string): ChatStateEvent | null {
    if (!this.chats.has(chatId)) return null;
    const facts = this.facts.get(chatId) ?? emptyFacts();
    const held =
      localId === undefined ? [] : facts.held.filter((id) => id !== localId && id !== '*');
    return this.applyFacts(
      chatId,
      { ...facts, held, heldExpired: message },
      { tell: false, own: true },
    );
  }

  /** The account feed's latest position (spec/03 § Account feed). */
  feedPosition(): number {
    return this.feedCounter;
  }

  /** Every chat whose row changed after `after`, oldest change first. */
  changedSince(after: number): ChatSummary[] {
    return [...this.chats.values()]
      .filter((c) => (c.feedPos ?? 0) > after)
      .sort((a, b) => (a.feedPos ?? 0) - (b.feedPos ?? 0));
  }

  /** The chat's whole list entry as a `chat.state`, or null when unknown. */
  stateEventFor(chatId: string): ChatStateEvent | null {
    const row = this.chats.get(chatId);
    return row ? this.stateEventOf(row) : null;
  }

  /** The `chat.state` a surface needs to draw this row as the server holds it. */
  private stateEventOf(next: ChatSummary): ChatStateEvent {
    // The turn this state belongs to, as its host last described it: a status
    // change a fact made (the turn ending) speaks for that turn like the host's
    // own frame does (spec/09 § Whose turn it was, § What the message says).
    const turn = this.turnDetails.get(next.chatId);
    return {
      ...(turn ?? {}),
      type: 'chat.state',
      chatId: next.chatId,
      hostId: next.hostId,
      activity: next.activity,
      permissionMode: next.permissionMode,
      status: next.status,
      lastUpdated: next.lastUpdated,
      name: next.name,
      preview: next.preview,
      ...(next.lastMessagePreview !== undefined
        ? { lastMessagePreview: next.lastMessagePreview }
        : {}),
      ...((next.lastSeq ?? 0) > 0 ? { lastSeq: next.lastSeq } : {}),
      // `folder` on the wire is min(1); a spawned chat always has one, but guard
      // against an empty mirror value so `decode()` never rejects the frame.
      ...(next.folder ? { folder: next.folder } : {}),
      pinned: next.pinned,
      pinnedAt: next.pinnedAt,
      snoozedUntil: next.snoozedUntil,
      snoozeRecords: next.snoozeRecords,
      runningSince: next.runningSince,
      hidden: next.hidden,
      ...(next.lastError ? { lastError: next.lastError as ChatStateEvent['lastError'] } : {}),
      ...(next.chatStatus ? { chatStatus: next.chatStatus } : {}),
      ...(next.feedPos !== undefined ? { feedPos: next.feedPos } : {}),
      goal: next.goal,
      goalProgress: next.goalProgress,
      lastGoal: next.lastGoal,
      goalQueue: next.goalQueue,
      goalReminderEvery: next.goalReminderEvery,
      goalCheckInEvery: next.goalCheckInEvery,
      reminder: next.reminder,
      statusSummary: next.statusSummary,
      statusKind: next.statusKind,
      statusDeclared: next.statusDeclared,
      todos: next.todos,
      pendingWake: next.pendingWake,
      ...(next.model ? { model: next.model } : {}),
      effort: next.effort,
      ...(typeof next.backgroundTasks === 'number'
        ? { backgroundTasks: next.backgroundTasks }
        : {}),
      ...(typeof next.runningAgents === 'number' ? { runningAgents: next.runningAgents } : {}),
      context: next.context,
      disabled: next.disabled,
      lastUserActivity: next.lastUserActivity,
      ...(next.createdAt !== undefined ? { createdAt: next.createdAt } : {}),
      ...(next.continuedFrom !== undefined ? { continuedFrom: next.continuedFrom } : {}),
      ...(next.continuedIn !== undefined ? { continuedIn: next.continuedIn } : {}),
    };
  }

  /**
   * Record that `newChatId` continues `oldChatId` (spec/04 § Provider
   * switches, § Moving to another host): the new chat's `continuedFrom` and
   * the old one's `continuedIn`. Returns the `chat.state` of each row that
   * changed, for the caller to broadcast. A chat the mirror does not hold is
   * an error: the link is only made for two chats the server knows.
   */
  linkContinuation(newChatId: string, oldChatId: string): ChatStateEvent[] {
    const fresh = this.chats.get(newChatId);
    const old = this.chats.get(oldChatId);
    if (!fresh) throw new Error(`linkContinuation: unknown chat ${newChatId}`);
    if (!old) throw new Error(`linkContinuation: unknown chat ${oldChatId}`);
    const nextFresh: ChatSummary = {
      ...fresh,
      continuedFrom: oldChatId,
      feedPos: ++this.feedCounter,
    };
    const nextOld: ChatSummary = { ...old, continuedIn: newChatId, feedPos: ++this.feedCounter };
    this.chats.set(newChatId, nextFresh);
    this.chats.set(oldChatId, nextOld);
    this.markDirty();
    return [this.stateEventOf(nextFresh), this.stateEventOf(nextOld)];
  }

  /**
   * The chat has moved to another host (spec/04 § Moving a chat to another
   * host). `hostId` is otherwise fixed at `chat.spawned` for the chat's life,
   * and it is what routes every later frame for the chat, so a move is the one
   * thing that changes it. No-op if unknown.
   */
  rehome(chatId: string, hostId: string, folder: string): void {
    const existing = this.chats.get(chatId);
    if (!existing) return;
    this.chats.set(chatId, { ...existing, hostId, folder });
    this.unconfirmed.delete(chatId);
    this.markDirty();
  }

  /** Remove a chat row from the registry mirror. The host remains source of
   *  truth for the on-disk transcript. */
  remove(chatId: string): void {
    this.chats.delete(chatId);
    this.spawnedSet.delete(chatId);
    this.unconfirmed.delete(chatId);
    this.workedAt.delete(chatId);
    this.facts.delete(chatId);
    this.markDirty();
  }

  /**
   * Optimistically flip a chat's mirror status to `deleted` (soft-delete) or
   * back to `active` (restore) so the REST active/deleted lists update the
   * instant the DELETE / restore route runs, without waiting for the host's
   * `chat.state` echo (which reconciles it identically). No-op if unknown.
   * spec/04 § Lifecycle.
   */
  setDeleted(chatId: string, deleted: boolean): void {
    const existing = this.chats.get(chatId);
    if (!existing) return;
    this.chats.set(chatId, { ...existing, status: deleted ? 'deleted' : 'active' });
    this.markDirty();
  }

  /**
   * List chats. Default: active only (no archived, no deleted). `archivedOnly`
   * → only archived; `includeArchived` → active + archived (never deleted);
   * `deletedOnly` → only soft-deleted (spec/04 § Lifecycle). Sorted: pinned
   * first (by pinnedAt desc), then most-recent.
   */
  list(
    opts: {
      includeArchived?: boolean;
      archivedOnly?: boolean;
      deletedOnly?: boolean;
      snoozedOnly?: boolean;
      includeSnoozed?: boolean;
      /** Only hidden chats (spec/04 § Hidden) — the sidebar's Hidden section. */
      hiddenOnly?: boolean;
      /**
       * Only job-spawned chats (spec/08 § Action), active or archived. This is
       * ORTHOGONAL to the other lifecycle filters — an automation chat is
       * usually archived, so it must show here independent of archived
       * status, alongside wherever else it also sits (spec/14 § Sidebar).
       */
      automationsOnly?: boolean;
      /**
       * Tiebreak direction for chats that aren't pinned-against-each-other:
       * `'desc'` (default) is most-recent-first, matching every filter's own
       * page-one intuition except Hidden/Automations, whose sidebar bucket
       * displays FIFO oldest-first (`web/src/lib/chatGroups.ts`) — callers
       * paging those two pass `'asc'` so a page's fetch order already matches
       * the order it's about to be drawn in, and "scroll down for more" adds
       * rows at the bottom instead of splicing them in above what's on screen.
       */
      order?: 'asc' | 'desc';
    } = {},
  ): ChatSummary[] {
    const all = Array.from(this.chats.values());
    const now = this.now();
    // spec/04 § Snooze: derived from the clock on every call, so a snooze that
    // lapsed while nothing was listening still shows up as active.
    const isSnoozed = (c: ChatSummary): boolean =>
      c.snoozedUntil !== null && c.snoozedUntil > now && c.status === 'active';
    const filtered = all.filter((c) => {
      // Special threads (Manager / Speakers) are pinned UI surfaces,
      // not inbox chats — the sidebar's Channels section always shows them. They
      // are never archived/deleted/job-spawned, so include them only in the
      // active/default list (never in the Archived-only, Deleted-only or
      // Automations-only views).
      if (isReservedSpecialThread(c.chatId))
        return (
          !opts.archivedOnly &&
          !opts.deletedOnly &&
          !opts.snoozedOnly &&
          !opts.hiddenOnly &&
          !opts.automationsOnly
        );
      // Soft-deleted chats live only in the Deleted view.
      if (opts.deletedOnly) return c.status === 'deleted';
      if (c.status === 'deleted') return false;
      // Automations: every job-spawned chat, whatever its archived/snoozed
      // state — checked before those filters narrow the set further.
      if (opts.automationsOnly) return c.jobId !== null;
      // Hidden chats live only in the Hidden view (spec/04 § Hidden) — before
      // snooze, so a hidden chat that is also snoozed is drawn once, here.
      const hidden = c.hidden && c.status === 'active';
      if (opts.hiddenOnly) return hidden;
      if (hidden) return false;
      // Snoozed chats live only in the Snoozed view until their wake time.
      if (opts.snoozedOnly) return isSnoozed(c);
      if (opts.archivedOnly) return c.status === 'archived';
      if (!opts.includeSnoozed && isSnoozed(c)) return false;
      if (opts.includeArchived) return true;
      return c.status !== 'archived';
    });
    filtered.sort((a, b) => compareChatOrder(chatOrderKey(a), chatOrderKey(b), opts.order));
    return filtered;
  }

  /**
   * The folder roster (spec/04 § Folders → Folder roster): one row per distinct
   * folder across every NON-DELETED chat — archived and snoozed included —
   * carrying that folder's most-recent chat's `lastUpdated` and the host it
   * lives on. Most-recent-first.
   *
   * Served separately from `list()` because the sidebar's "Recent projects"
   * must include folders whose chats are ALL archived, while the cold-start
   * roster deliberately excludes archived chats to stay small. This is
   * O(folders), so it stays small however many archived chats accumulate.
   *
   * Special threads never contribute — Manager/Speakers are pinned UI
   * surfaces, not projects you would start a chat in (spec/06, and matching
   * `chatGroups.ts`'s own exclusion on the web side).
   */
  folders(): Array<{ folder: string; hostId: string; lastUpdated: number }> {
    const byFolder = new Map<string, { folder: string; hostId: string; lastUpdated: number }>();
    for (const c of this.chats.values()) {
      if (isReservedSpecialThread(c.chatId)) continue;
      // A soft-deleted chat stops contributing, exactly as on the web side —
      // deleting the last chat in a folder DOES retire the folder, archiving it
      // does not.
      if (c.status === 'deleted') continue;
      if (!c.folder) continue;
      const existing = byFolder.get(c.folder);
      if (existing && existing.lastUpdated >= c.lastUpdated) continue;
      byFolder.set(c.folder, {
        folder: c.folder,
        hostId: c.hostId,
        lastUpdated: c.lastUpdated,
      });
    }
    // Deterministic tiebreaker on folder path, so two folders that tie on
    // recency don't reorder between calls (same rule as `chatGroups.ts`).
    return Array.from(byFolder.values()).sort(
      (a, b) => b.lastUpdated - a.lastUpdated || a.folder.localeCompare(b.folder),
    );
  }

  size(): number {
    return this.chats.size;
  }
}

/**
 * The fields `ChatRegistry.list()` sorts on, and what an index-page cursor
 * carries (spec/01 § GET /api/chats). `chatId` is the final tiebreak, so
 * the order is total: two chats never compare equal, and "everything after
 * this key" is well defined even after the row the key came from has moved
 * or gone.
 */
export interface ChatOrderKey {
  pinned: boolean;
  pinnedAt: number | null;
  lastUpdated: number;
  chatId: string;
}

export function chatOrderKey(c: ChatSummary): ChatOrderKey {
  return { pinned: c.pinned, pinnedAt: c.pinnedAt, lastUpdated: c.lastUpdated, chatId: c.chatId };
}

/**
 * Sidebar order: pinned first (most-recently pinned at top, unknown pin time
 * last), then by `lastUpdated` in `order` (default most-recent first), then
 * by `chatId` ascending.
 */
export function compareChatOrder(
  a: ChatOrderKey,
  b: ChatOrderKey,
  order: 'asc' | 'desc' = 'desc',
): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.pinned && b.pinned) {
    const ap = a.pinnedAt;
    const bp = b.pinnedAt;
    if (ap === null && bp !== null) return 1;
    if (bp === null && ap !== null) return -1;
    if (ap !== null && bp !== null && ap !== bp) return bp - ap;
    // Both pinned with no pin time: most-recent first, whatever `order` says.
    if (ap === null && a.lastUpdated !== b.lastUpdated) return b.lastUpdated - a.lastUpdated;
  }
  if (a.lastUpdated !== b.lastUpdated) {
    return order === 'asc' ? a.lastUpdated - b.lastUpdated : b.lastUpdated - a.lastUpdated;
  }
  return a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0;
}

/**
 * The failure behind a status, in the shape older surfaces read (`lastError`).
 * Taken from the turn's own ended fact, never from a host's conclusion; `at`
 * holds while the failure is the same one.
 */
function lastErrorOf(
  facts: ChatStatusFacts,
  prev: ChatSummary['lastError'],
  since: number,
): ChatSummary['lastError'] {
  let next: { code: string; message: string } | null = null;
  if (facts.heldExpired !== null) {
    next = { code: 'held_message_expired', message: facts.heldExpired };
  } else if (facts.openTurns.length === 0 && facts.lastEnd?.outcome === 'failed') {
    next = facts.lastEnd.error ?? { code: 'unknown', message: 'The turn failed.' };
  }
  if (next === null) return null;
  if (prev && prev.code === next.code && prev.message === next.message) return prev;
  return { ...next, at: since };
}
