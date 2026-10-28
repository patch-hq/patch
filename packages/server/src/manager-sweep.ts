// The Manager sweep (spec/06 § Sweep) — a periodic, gated nudge for stalled
// chats, replacing the per-event Manager watch loop that used to run a full
// Manager turn for every chat event.
//
// Deterministic here, judged on the Manager host: this tracks which chats
// changed and why (the gate), decides WHEN a sweep is due (interval, or an
// early event-wake, debounced), and builds the candidate list. It never
// reads a transcript or calls a model itself — that happens on the Manager
// host (`managerSweepGen.ts`, `ChatRunner.runManagerSweep`), the one
// component with both local and cross-host read access and the account's
// OAuth. The sweep's actions (nudge/wake/flag) are therefore also executed
// there; this module only ever decides whether to ask for a run and records
// what came back.

import type { Logger } from 'pino';
import type {
  ChatStateEvent,
  ManagerSweepAction,
  ManagerSweepCandidate,
  WireEvent,
} from '@patch/wire';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import type { ChatRegistry, ChatSummary } from './chat-registry.js';
import type { AccountSettings } from './settings.js';

/** Why a chat is a sweep candidate. One per chat per run — the most urgent edge wins. */
export type SweepEdge = ManagerSweepCandidate['edge'];

const EDGE_RANK: Record<SweepEdge, number> = {
  permission: 0,
  question: 1,
  'job-failed': 2,
  'task-ended': 3,
  stalled: 4,
  settled: 5,
};

/** Debounce floor between two event-woken early sweeps (spec/06 § Sweep — "at most once per 2 min"). */
export const EVENT_WAKE_DEBOUNCE_MS = 2 * 60_000;

/**
 * How long a requested run may go without its result before the sweep stops
 * waiting for it. The host's own model call gives up after 30s; this is far
 * past that, for a result that will never come (the host restarted mid-run).
 */
export const IN_FLIGHT_STALE_MS = 10 * 60_000;

export interface SweepRunRecord {
  at: number;
  runId: string;
  candidateCount: number;
  actions: ManagerSweepAction[];
  tokensUsed: number;
  error?: string;
}

/** Persists sweep runs the same way job runs are persisted — a flat, bounded, append-only log (spec/06 § Sweep — "Sweep runs are also listed like job runs"). */
export interface SweepRunStore {
  append(record: SweepRunRecord): void;
  recent(limit?: number): SweepRunRecord[];
}

export interface ManagerSweeperDeps {
  chats: ChatRegistry;
  settings: () => AccountSettings;
  /** The Manager host to run the sweep on, or undefined if none is registered yet. */
  managerHostId: () => string | undefined;
  /** Ask the Manager host to run a sweep (fire-and-forget — the result arrives later via `onResult`). */
  runSweep: (req: {
    runId: string;
    candidates: ManagerSweepCandidate[];
    messagesPerChat: number;
    prompt: string;
    model: string;
  }) => void;
  /**
   * Tell the Manager host the sweep is switched off, so it abandons a run in
   * flight and drops queued nudges. Returns whether the host was reached.
   */
  cancelSweep: () => boolean;
  runs: SweepRunStore;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
  idGenerator?: () => string;
}

export class ManagerSweeper {
  private readonly deps: ManagerSweeperDeps;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  /** The most urgent edge seen for each chat since the last sweep. */
  private readonly pending = new Map<string, SweepEdge>();
  private readonly lastActivity = new Map<string, ChatSummary['activity']>();
  private readonly lastStatusKind = new Map<string, string | null>();
  /** When a chat currently `running` entered that activity — the clock `checkStalled` compares against. */
  private readonly runningSince = new Map<string, number>();
  /** When each chat last showed real activity — any event on it other than queue bookkeeping or an unchanged state echo. */
  private readonly lastActivityAt = new Map<string, number>();
  private readonly lastUpdatedSeen = new Map<string, number>();
  private readonly lastBackgroundTasks = new Map<string, number | null>();
  /** When `stalled` was last raised for a chat — the next one needs another full threshold of silence. */
  private readonly lastStalledAt = new Map<string, number>();
  /** Chats holding a sweep nudge or wake that has not been acted on yet; they are not candidates until it is. */
  private readonly awaitingSweepMessage = new Set<string>();
  private lastSweepAt: number;
  /** When a sweep last actually ran; 0 until one has, unlike `lastSweepAt` which boot also sets. */
  private lastRunAt = 0;
  private lastEventWakeAt = 0;
  /** True once the host has been told the sweep is off; cleared when it is back on. */
  private cancelSent = false;
  private eventWakeArmed = false;
  /** Set while a run's result hasn't come back yet — only one sweep in flight at a time. */
  private inFlightRunId: string | undefined;
  private inFlightSince = 0;

  constructor(deps: ManagerSweeperDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.idGenerator =
      deps.idGenerator ?? (() => `sweep-${this.now()}-${Math.random().toString(36).slice(2)}`);
    // Boot counts as "just swept" — otherwise the interval clock reads as
    // infinitely overdue from the moment the server starts, and the very
    // first thing that changes fires immediately regardless of the
    // configured interval.
    this.lastSweepAt = this.now();
  }

  /** True when the chat is pending afterwards; false when the edge was dropped. */
  private raise(chatId: string, edge: SweepEdge): boolean {
    if (chatId === SPECIAL_THREAD_IDS.manager) return false; // the sweep is never a candidate on itself
    // Off, by either switch (the Manager's Power icon — spec/06 § Disabled —
    // or the sweep's own Enabled setting), means no sweep traffic and no
    // backlog that floods in the moment it is turned back on.
    if (this.isOff()) return false;
    // A chat that already holds a sweep message has been told; another one
    // would only stack behind it. Real needs (a question or permission) still
    // come through, because they are the user's, not the sweep's.
    if (this.awaitingSweepMessage.has(chatId) && EDGE_RANK[edge] > EDGE_RANK['task-ended'])
      return false;
    const existing = this.pending.get(chatId);
    if (existing !== undefined && EDGE_RANK[existing] <= EDGE_RANK[edge]) return true;
    this.pending.set(chatId, edge);
    return true;
  }

  /** The sweep is switched off: Manager disabled, or the sweep setting off. */
  private isOff(): boolean {
    return (
      this.deps.chats.get(SPECIAL_THREAD_IDS.manager)?.disabled === true ||
      !this.deps.settings().sweepEnabled
    );
  }

  private dropPending(): void {
    this.pending.clear();
    this.eventWakeArmed = false;
  }

  /** Off: forget what was queued up, and (once) tell the host to stop what it has in hand. */
  private handleOff(): void {
    this.dropPending();
    if (this.cancelSent) return;
    if (this.deps.managerHostId() === undefined) return;
    this.inFlightRunId = undefined;
    this.cancelSent = this.deps.cancelSweep();
  }

  /**
   * Debounced early wake (spec/06 § Sweep — "Event-woken"). A no-op inside the
   * debounce window, which runs from the last wake OR the last sweep, so an
   * early wake can never fire a sweep sooner than the debounce after one ran.
   */
  private wakeEarly(): void {
    const now = this.now();
    if (now - Math.max(this.lastEventWakeAt, this.lastRunAt) < EVENT_WAKE_DEBOUNCE_MS) return;
    this.lastEventWakeAt = now;
    this.eventWakeArmed = true;
  }

  /** Observe the chat stream and raise the edges a sweep cares about. */
  observe(event: WireEvent): void {
    this.noteActivity(event);
    if (event.type === 'chat.dequeued') {
      this.awaitingSweepMessage.delete(event.chatId);
      return;
    }
    if (event.type !== 'chat.state') return;
    this.observeState(event);
  }

  /**
   * Stall detection measures silence, so every sign a chat is alive resets it:
   * messages, tool calls, output deltas, state changes. Queue bookkeeping is not
   * the chat working, and a `chat.state` echo whose `lastUpdated` has not moved
   * is not either.
   */
  private noteActivity(event: WireEvent): void {
    if (!('chatId' in event) || typeof event.chatId !== 'string') return;
    if (event.type === 'chat.queued' || event.type === 'chat.dequeued') return;
    if (event.type === 'chat.state') {
      const seen = this.lastUpdatedSeen.get(event.chatId);
      if (typeof event.lastUpdated === 'number')
        this.lastUpdatedSeen.set(event.chatId, event.lastUpdated);
      const becameRunning =
        event.activity === 'running' && this.lastActivity.get(event.chatId) !== 'running';
      if (!becameRunning && (event.lastUpdated === undefined || event.lastUpdated === seen)) return;
    }
    this.lastActivityAt.set(event.chatId, this.now());
  }

  private observeState(event: ChatStateEvent): void {
    const chatId = event.chatId;
    // Archived / snoozed / hidden / deleted chats are not the user's problem
    // right now — same filters the old watch loop used (spec/06).
    const status = event.status ?? this.deps.chats.get(chatId)?.status ?? 'active';
    if (status !== 'active') return;
    const snoozedUntil = event.snoozedUntil ?? this.deps.chats.get(chatId)?.snoozedUntil ?? null;
    if (snoozedUntil !== null && snoozedUntil > this.now()) return;
    if (event.hidden ?? this.deps.chats.get(chatId)?.hidden ?? false) return;

    const previousActivity = this.lastActivity.get(chatId);
    const previousKind = this.lastStatusKind.get(chatId);
    if (event.activity !== undefined) this.lastActivity.set(chatId, event.activity);
    const kind = event.statusKind ?? null;
    if (event.statusKind !== undefined) this.lastStatusKind.set(chatId, kind);
    const declared = event.statusDeclared ?? false;

    if (event.activity === 'running' && previousActivity !== 'running') {
      this.runningSince.set(chatId, this.now());
    } else if (event.activity !== undefined && event.activity !== 'running') {
      this.runningSince.delete(chatId);
      this.lastStalledAt.delete(chatId);
    }
    // The chat moved on (a turn started or ended), so whatever the sweep last
    // sent it has been acted on and the chat is a candidate again.
    if (event.activity !== undefined && event.activity !== previousActivity) {
      this.awaitingSweepMessage.delete(chatId);
    }

    if (kind === 'question' && declared && previousKind !== 'question')
      this.raise(chatId, 'question');
    if (event.activity !== undefined && event.activity !== previousActivity) {
      if (event.activity === 'awaiting-permission') this.raise(chatId, 'permission');
      // A settled chat may be the one asking "shall I do the next bit?" —
      // exactly the sweep's own reason to exist (spec/06 § Sweep — PURPOSE).
      // A turn the user stopped did not settle (spec/09 § A turn the user
      // stopped) — same exclusion the old watch loop made.
      else if (
        event.activity === 'idle' &&
        previousActivity === 'running' &&
        event.turnStopped !== true &&
        // A turn the sweep's own nudge or wake started settling is not news.
        // Raising it would nudge the chat again, forever.
        event.turnOrigin !== 'machine'
      ) {
        this.raise(chatId, 'settled');
      }
    }

    // `backgroundTasks` already aggregates every backgrounded command,
    // sub-agent AND `Monitor`/`patch_watch` task (`@patch/wire`'s
    // background-task-tracking.ts) — a drop to zero is "a monitor/
    // patch_watch/background task ended" (spec/06 § Sweep — Gate).
    if (event.backgroundTasks !== undefined) {
      const prev = this.lastBackgroundTasks.get(chatId) ?? null;
      this.lastBackgroundTasks.set(chatId, event.backgroundTasks);
      if (prev !== null && prev > 0 && event.backgroundTasks === 0) {
        if (this.raise(chatId, 'task-ended')) this.wakeEarly();
      }
    }
  }

  /** A job run failure wakes a sweep early. No-op without a chat to flag — see `jobs/logs.ts`'s `isJobRunFailure`. */
  jobRunFailed(chatId: string | null): void {
    if (chatId === null) return;
    // A dropped edge leaves nothing for a sweep to look at, so it must not wake one.
    if (this.raise(chatId, 'job-failed')) this.wakeEarly();
  }

  private toCandidate(chatId: string, edge: SweepEdge): ManagerSweepCandidate | undefined {
    const chat = this.deps.chats.get(chatId);
    if (!chat) return undefined; // vanished since it was raised — nothing to ask about
    const since = this.quietSince(chatId) ?? chat.lastUpdated;
    const idleMinutes = Math.max(0, (this.now() - since) / 60_000);
    return { chatId, hostId: chat.hostId, folder: chat.folder, edge, idleMinutes };
  }

  /** The moment the running chat last did anything — the later of its turn starting and its last activity. */
  private quietSince(chatId: string): number | undefined {
    const since = this.runningSince.get(chatId);
    if (since === undefined) return undefined;
    return Math.max(since, this.lastActivityAt.get(chatId) ?? 0);
  }

  /**
   * Raise `stalled` for every chat that's been running past the threshold.
   * May need a wake-up even though it "expected" to stop (spec/06 § Sweep —
   * Gate) — which is exactly what the interval wait is for everything ELSE,
   * so a stall wakes a sweep early the same as an event does, rather than
   * sitting pending for however long is left on the clock.
   */
  private checkStalled(thresholdMinutes: number): void {
    const thresholdMs = thresholdMinutes * 60_000;
    const now = this.now();
    for (const chatId of this.runningSince.keys()) {
      // A chat still producing tool calls or output is working, not stalled:
      // the clock runs from its last activity. `stalled` fires once per quiet
      // stretch: it also restarts from the last time it was raised, so a long
      // silent step is not re-raised every tick.
      const quietSince = Math.max(
        this.quietSince(chatId) ?? 0,
        this.lastStalledAt.get(chatId) ?? 0,
      );
      if (now - quietSince < thresholdMs) continue;
      const chat = this.deps.chats.get(chatId);
      if (chat?.activity !== 'running') continue;
      this.lastStalledAt.set(chatId, now);
      if (this.raise(chatId, 'stalled')) this.wakeEarly();
    }
  }

  private attemptFire(): boolean {
    // Edges queued before the sweep was turned off must not fire after it.
    if (this.isOff()) {
      this.handleOff();
      return false;
    }
    if (this.pending.size === 0) return false; // NOTHING CHANGED = no model call
    const settings = this.deps.settings();
    if (this.inFlightRunId !== undefined) {
      if (this.now() - this.inFlightSince < IN_FLIGHT_STALE_MS) return false;
      this.deps.logger.warn(
        { runId: this.inFlightRunId },
        'manager-sweep: run never reported back, no longer waiting for it',
      );
      this.inFlightRunId = undefined;
    }
    const managerHostId = this.deps.managerHostId();
    if (!managerHostId) return false;
    const candidates = [...this.pending.entries()]
      .map(([chatId, edge]) => this.toCandidate(chatId, edge))
      .filter((c): c is ManagerSweepCandidate => c !== undefined);
    this.pending.clear();
    this.eventWakeArmed = false;
    this.lastSweepAt = this.now();
    if (candidates.length === 0) return false; // every pending chat had vanished
    this.lastRunAt = this.lastSweepAt;
    const runId = this.idGenerator();
    this.inFlightRunId = runId;
    this.inFlightSince = this.lastRunAt;
    this.deps.runSweep({
      runId,
      candidates,
      messagesPerChat: settings.sweepMessagesPerChat,
      prompt: settings.sweepPrompt,
      model: settings.sweepModel,
    });
    this.deps.logger.info({ runId, chats: candidates.length }, 'manager-sweep: run requested');
    return true;
  }

  /**
   * Called on a steady tick. Fires when something is pending AND either the
   * interval has elapsed or an event-wake is armed. Returns whether a run was
   * requested, which is what the tests assert on.
   */
  tick(): boolean {
    const settings = this.deps.settings();
    if (this.isOff()) {
      this.handleOff();
      return false;
    }
    this.cancelSent = false;
    this.checkStalled(settings.stalledThresholdMinutes);
    const intervalMs = settings.sweepIntervalMinutes * 60_000;
    const dueByInterval = this.now() - this.lastSweepAt >= intervalMs;
    if (!dueByInterval && !this.eventWakeArmed) return false;
    return this.attemptFire();
  }

  /** "Check now" (spec/06 § Sweep) — a button, tool, or CLI command forcing an attempt right now. Still gated: nothing pending is still no model call. */
  checkNow(): boolean {
    return this.attemptFire();
  }

  /** The Manager host's report of what a run did (spec/06 § Sweep — Visible). */
  onResult(event: {
    runId: string;
    actions: ManagerSweepAction[];
    tokensUsed: number;
    error?: string;
  }): void {
    if (this.inFlightRunId === event.runId) this.inFlightRunId = undefined;
    for (const a of event.actions) {
      if (a.action === 'nudge' || a.action === 'wake') this.awaitingSweepMessage.add(a.chatId);
    }
    this.deps.runs.append({
      at: this.now(),
      runId: event.runId,
      candidateCount: event.actions.length,
      actions: event.actions,
      tokensUsed: event.tokensUsed,
      ...(event.error !== undefined ? { error: event.error } : {}),
    });
    // spec/06 § Sweep — "Cost check: log tokens per sweep." One line per run,
    // the server-side half of the host's own log line — grep either for a
    // day's running total once this is live.
    if (event.error !== undefined) {
      this.deps.logger.warn(
        { runId: event.runId, error: event.error },
        'manager-sweep: run failed',
      );
    } else {
      this.deps.logger.info(
        { runId: event.runId, chats: event.actions.length, tokensUsed: event.tokensUsed },
        'manager-sweep: run recorded',
      );
    }
  }

  /** Test/diagnostics: the edges currently waiting for the next sweep. */
  pendingEdges(): { chatId: string; edge: SweepEdge }[] {
    return [...this.pending.entries()].map(([chatId, edge]) => ({ chatId, edge }));
  }
}
