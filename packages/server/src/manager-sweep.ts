// The Manager sweep (spec/06 § The sweep) — the periodic half of the
// Manager's two automatic jobs: answer the rote questions its principles
// prompt covers, and batch the rest into a digest.
//
// Code here supplies only facts: which chats went idle since the last check,
// and when a check is due (the interval, or "Check now"). Everything that is
// judgement — is this a question, does a principle cover it — is the
// principles prompt's, run on the Manager host (`managerSweepGen.ts`,
// `ChatRunner.runManagerSweep`), the one component with both local and
// cross-host read access and the account's OAuth. This module never reads a
// transcript or calls a model; it decides whether to ask for a run and
// records what came back.

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
  /** Chats that went idle since the last check. */
  private readonly pending = new Set<string>();
  private readonly lastActivity = new Map<string, ChatSummary['activity']>();
  /** When each chat last went idle after running — the clock behind a candidate's `idleMinutes`. */
  private readonly idleSince = new Map<string, number>();
  private lastSweepAt: number;
  /** True once the host has been told the sweep is off; cleared when it is back on. */
  private cancelSent = false;
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

  /** The sweep is switched off: Manager disabled, or the sweep setting off. */
  private isOff(): boolean {
    return (
      this.deps.chats.get(SPECIAL_THREAD_IDS.manager)?.disabled === true ||
      !this.deps.settings().sweepEnabled
    );
  }

  /** Off: forget what was queued up, and (once) tell the host to stop what it has in hand. */
  private handleOff(): void {
    this.pending.clear();
    if (this.cancelSent) return;
    if (this.deps.managerHostId() === undefined) return;
    this.inFlightRunId = undefined;
    this.cancelSent = this.deps.cancelSweep();
  }

  /** Observe the chat stream and note which chats went idle. */
  observe(event: WireEvent): void {
    if (event.type !== 'chat.state') return;
    this.observeState(event);
  }

  private observeState(event: ChatStateEvent): void {
    const chatId = event.chatId;
    const previousActivity = this.lastActivity.get(chatId);
    if (event.activity !== undefined) this.lastActivity.set(chatId, event.activity);
    if (chatId === SPECIAL_THREAD_IDS.manager) return; // the sweep is never a candidate on itself
    // Off, by either switch, means nothing is collected and no backlog floods
    // in the moment it is turned back on.
    if (this.isOff()) return;
    // Archived / snoozed / hidden chats are not the user's problem right now.
    const status = event.status ?? this.deps.chats.get(chatId)?.status ?? 'active';
    if (status !== 'active') return;
    const snoozedUntil = event.snoozedUntil ?? this.deps.chats.get(chatId)?.snoozedUntil ?? null;
    if (snoozedUntil !== null && snoozedUntil > this.now()) return;
    if (event.hidden ?? this.deps.chats.get(chatId)?.hidden ?? false) return;

    // A turn the user stopped did not end in a question (spec/09 § A turn the
    // user stopped).
    if (event.activity === 'idle' && previousActivity === 'running' && event.turnStopped !== true) {
      this.pending.add(chatId);
      this.idleSince.set(chatId, this.now());
    }
    // It started working again before the check: whatever it asked is stale.
    if (event.activity === 'running') this.pending.delete(chatId);
  }

  private toCandidate(chatId: string): ManagerSweepCandidate | undefined {
    const chat = this.deps.chats.get(chatId);
    if (!chat) return undefined; // vanished since it went idle — nothing to ask about
    const since = this.idleSince.get(chatId) ?? chat.lastUpdated;
    const idleMinutes = Math.max(0, (this.now() - since) / 60_000);
    return { chatId, hostId: chat.hostId, folder: chat.folder, edge: 'settled', idleMinutes };
  }

  private attemptFire(): boolean {
    // Chats queued before the sweep was turned off must not fire after it.
    if (this.isOff()) {
      this.handleOff();
      return false;
    }
    if (this.pending.size === 0) return false; // NOTHING WENT IDLE = no model call
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
    const candidates = [...this.pending]
      .map((chatId) => this.toCandidate(chatId))
      .filter((c): c is ManagerSweepCandidate => c !== undefined);
    this.pending.clear();
    this.lastSweepAt = this.now();
    if (candidates.length === 0) return false; // every pending chat had vanished
    const runId = this.idGenerator();
    this.inFlightRunId = runId;
    this.inFlightSince = this.lastSweepAt;
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
   * Called on a steady tick. Fires when something went idle AND the interval
   * has elapsed. Returns whether a run was requested, which is what the tests
   * assert on.
   */
  tick(): boolean {
    if (this.isOff()) {
      this.handleOff();
      return false;
    }
    this.cancelSent = false;
    const intervalMs = this.deps.settings().sweepIntervalMinutes * 60_000;
    if (this.now() - this.lastSweepAt < intervalMs) return false;
    return this.attemptFire();
  }

  /** "Check now" (spec/06 § The sweep) — a button, tool, or CLI command forcing an attempt right now. Still gated: nothing gone idle is still no model call. */
  checkNow(): boolean {
    return this.attemptFire();
  }

  /** The Manager host's report of what a run did (spec/06 § The sweep — Visible). */
  onResult(event: {
    runId: string;
    actions: ManagerSweepAction[];
    tokensUsed: number;
    error?: string;
  }): void {
    if (this.inFlightRunId === event.runId) this.inFlightRunId = undefined;
    this.deps.runs.append({
      at: this.now(),
      runId: event.runId,
      candidateCount: event.actions.length,
      actions: event.actions,
      tokensUsed: event.tokensUsed,
      ...(event.error !== undefined ? { error: event.error } : {}),
    });
    // "Cost check: log tokens per sweep." One line per run, the server-side
    // half of the host's own log line.
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

  /** Test/diagnostics: the chats that went idle and are waiting for the next check. */
  pendingChats(): string[] {
    return [...this.pending];
  }
}
