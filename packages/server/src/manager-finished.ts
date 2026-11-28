// Finished chats → the Manager (spec/06 § Finished chats).
//
// The server sees every host's chats, so it is the one that notices a chat
// finishing. It decides only which chats count and when a delivery is due
// (`managerWake`); the turn itself — reading each chat's last reply and
// sending one message into the Manager — is the Manager's home host's
// (`ChatRunner.deliverFinishedChats`).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import type {
  ChatStateEvent,
  ManagerFinishedChat,
  ManagerFinishedResultEvent,
  WireEvent,
} from '@patch/wire';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import type { ChatRegistry } from './chat-registry.js';
import type { AccountSettings } from './settings.js';

/**
 * How long a delivery may go without its result before the collector stops
 * waiting for it (the host restarted mid-delivery). Reading a few chats'
 * history across hosts takes seconds; this is far past that.
 */
export const IN_FLIGHT_STALE_MS = 10 * 60_000;

/** After a delivery fails, how long its chats wait before they are sent again. */
export const RETRY_AFTER_FAILURE_MS = 5 * 60_000;

const SPECIAL_IDS: ReadonlySet<string> = new Set(Object.values(SPECIAL_THREAD_IDS));

/** What survives a server restart: the chats still to deliver and the batch clock. */
const StoredFile = z
  .object({
    version: z.literal(1),
    pending: z.array(z.string().min(1)),
    lastDeliveryAt: z.number().int().nonnegative(),
  })
  .strict();

export interface ManagerFinishedDeps {
  chats: ChatRegistry;
  settings: () => AccountSettings;
  /** The Manager's home host when it is online, else undefined. */
  managerHostId: () => string | undefined;
  /** The name the user gave a host, when it has one. */
  hostName?: (hostId: string) => string | undefined;
  /** Ask the home host to deliver (fire-and-forget; the result arrives via `onResult`). */
  deliver: (req: { runId: string; chats: ManagerFinishedChat[]; windowMinutes?: number }) => void;
  /**
   * Tell the user a delivery failed where the Manager's thread could not say
   * so itself (the home host never answered, or answered without writing it).
   */
  reportFailure?: (message: string) => void;
  /** Where the pending chats and batch clock are kept; memory only when absent. */
  path?: string;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  now?: () => number;
  idGenerator?: () => string;
}

export class ManagerFinishedCollector {
  private readonly deps: ManagerFinishedDeps;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  /** Chats that finished since the last delivery, in the order they finished. */
  private pending = new Set<string>();
  private readonly lastActivity = new Map<string, ChatSummaryActivity>();
  /** Each chat's goal as last seen, so a goal being cleared on an idle chat is noticed. */
  private readonly lastGoal = new Map<string, string | null>();
  private lastDeliveryAt: number;
  /** The delivery whose result has not come back — one at a time — and its chats. */
  private inFlight: { runId: string; since: number; chats: string[] } | undefined;
  /** Set after a failed delivery: its chats are sent again once this passes. */
  private retryAfter: number | undefined;
  /** Whether the user has been told about the current run of failures. */
  private failureReported = false;

  constructor(deps: ManagerFinishedDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.idGenerator =
      deps.idGenerator ?? (() => `finished-${this.now()}-${Math.random().toString(36).slice(2)}`);
    // Boot counts as "just delivered" when nothing was kept, so the batch
    // clock does not read as overdue the moment the server starts.
    this.lastDeliveryAt = this.now();
    this.load();
  }

  private load(): void {
    const { path } = this.deps;
    if (path === undefined) return;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.deps.logger.error(
        { path, err: (err as Error).message },
        'manager-finished: could not read the pending chats, starting empty',
      );
      return;
    }
    try {
      const stored = StoredFile.parse(JSON.parse(text));
      this.pending = new Set(stored.pending);
      this.lastDeliveryAt = stored.lastDeliveryAt;
    } catch (err) {
      // Re-derivable: losing it costs one batch of finished chats, never the
      // server. Loud, so a broken file is seen.
      this.deps.logger.error(
        { path, err: (err as Error).message },
        'manager-finished: pending chats file is unreadable, starting empty',
      );
    }
  }

  /** Written atomically (temp file + rename); a chat in flight is kept until it is confirmed. */
  private save(): void {
    const { path } = this.deps;
    if (path === undefined) return;
    const pending = [...new Set([...(this.inFlight?.chats ?? []), ...this.pending])];
    const body: z.infer<typeof StoredFile> = {
      version: 1,
      pending,
      lastDeliveryAt: this.lastDeliveryAt,
    };
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    } catch (err) {
      this.deps.logger.error(
        { path, err: (err as Error).message },
        'manager-finished: could not write the pending chats',
      );
    }
  }

  /** Off: the setting is off, or the Manager is disabled. */
  private isOff(): boolean {
    return (
      this.deps.settings().managerWake === 'off' ||
      this.deps.chats.get(SPECIAL_THREAD_IDS.manager)?.disabled === true
    );
  }

  private clearPending(): void {
    this.retryAfter = undefined;
    this.failureReported = false;
    if (this.pending.size === 0) return;
    this.pending.clear();
    this.save();
  }

  observe(event: WireEvent): void {
    if (event.type !== 'chat.state') return;
    this.observeState(event);
  }

  private observeState(event: ChatStateEvent): void {
    const chatId = event.chatId;
    const previous = this.lastActivity.get(chatId);
    if (event.activity !== undefined) this.lastActivity.set(chatId, event.activity);
    const previousGoal = this.lastGoal.get(chatId);
    if (event.goal !== undefined) this.lastGoal.set(chatId, event.goal);
    if (SPECIAL_IDS.has(chatId)) return;
    // It started working again before the delivery went: it has not finished.
    if (event.activity === 'running') {
      if (this.pending.delete(chatId)) this.save();
      return;
    }
    // Off means nothing is collected, so no backlog floods in when it is turned on.
    if (this.isOff()) return;
    const wentIdle =
      event.activity === 'idle' && previous === 'running' && event.turnStopped !== true;
    // A goal met or given up ends the chat's work as surely as a turn does:
    // the host clears it in a later frame, with the chat already idle.
    const goalEnded =
      event.goal === null &&
      previousGoal !== undefined &&
      previousGoal !== null &&
      this.lastActivity.get(chatId) === 'idle';
    if (!wentIdle && !goalEnded) return;
    if (!this.eligible(chatId)) return;
    if (!this.pending.has(chatId)) {
      this.pending.add(chatId);
      this.save();
    }
    if (this.deps.settings().managerWake === 'each') this.attempt();
  }

  /**
   * Whether a chat is one the Manager is told about: active, idle, not
   * snoozed, not hidden, no goal in progress, not a special thread. Checked
   * when it finishes and again when the delivery goes.
   */
  private eligible(chatId: string): boolean {
    if (SPECIAL_IDS.has(chatId)) return false;
    const chat = this.deps.chats.get(chatId);
    if (!chat) return false;
    if (chat.status !== 'active') return false;
    // As the host last said: the registry's own activity is the server's verdict.
    const activity = this.lastActivity.get(chatId);
    if (activity === 'running' || activity === 'awaiting-permission') return false;
    if (chat.snoozedUntil !== null && chat.snoozedUntil > this.now()) return false;
    if (chat.hidden) return false;
    // A goal keeps the chat working on its own; it is not finished yet.
    if (chat.goal !== null) return false;
    return true;
  }

  private toChat(chatId: string): ManagerFinishedChat | undefined {
    if (!this.eligible(chatId)) return undefined;
    const chat = this.deps.chats.get(chatId)!;
    const hostName = this.deps.hostName?.(chat.hostId);
    return {
      chatId,
      hostId: chat.hostId,
      ...(hostName ? { hostName } : {}),
      folder: chat.folder,
      name: chat.name ?? basename(chat.folder),
    };
  }

  private attempt(force = false): boolean {
    if (this.isOff()) {
      this.clearPending();
      return false;
    }
    if (this.pending.size === 0) return false;
    if (this.inFlight !== undefined) {
      if (this.now() - this.inFlight.since < IN_FLIGHT_STALE_MS) return false;
      this.deps.logger.warn(
        { runId: this.inFlight.runId },
        'manager-finished: delivery never reported back, no longer waiting for it',
      );
      this.failed('the Manager’s home host did not answer', false);
    }
    if (!force && this.retryAfter !== undefined && this.now() < this.retryAfter) return false;
    const hostId = this.deps.managerHostId();
    // Kept for when the home host is back.
    if (!hostId) return false;
    const settings = this.deps.settings();
    const chats = [...this.pending]
      .map((id) => this.toChat(id))
      .filter((c): c is ManagerFinishedChat => c !== undefined);
    this.pending.clear();
    this.lastDeliveryAt = this.now();
    if (chats.length === 0) {
      this.save();
      return false;
    }
    const runId = this.idGenerator();
    this.inFlight = { runId, since: this.lastDeliveryAt, chats: chats.map((c) => c.chatId) };
    this.save();
    const batched = settings.managerWake === 'batched' && !force;
    try {
      this.deps.deliver({
        runId,
        chats,
        ...(batched ? { windowMinutes: settings.managerWakeIntervalMinutes } : {}),
      });
    } catch (err) {
      this.deps.logger.error(
        { runId, err: (err as Error).message },
        'manager-finished: delivery could not be sent',
      );
      this.failed((err as Error).message, false);
      return false;
    }
    this.deps.logger.info({ runId, chats: chats.length }, 'manager-finished: delivery requested');
    return true;
  }

  /**
   * A delivery did not land: its chats go back at the front of the queue and
   * are tried again after a pause. The user is told once per run of failures —
   * by the Manager's own thread when the home host wrote it there (`recorded`),
   * otherwise by a notification.
   */
  private failed(reason: string, recorded: boolean): void {
    const chats = this.inFlight?.chats ?? [];
    this.inFlight = undefined;
    // A disabled Manager is sent nothing and nothing is kept.
    if (this.isOff()) {
      this.clearPending();
      return;
    }
    this.pending = new Set([...chats, ...this.pending]);
    this.retryAfter = this.now() + RETRY_AFTER_FAILURE_MS;
    this.save();
    if (this.failureReported) return;
    this.failureReported = true;
    if (!recorded) {
      this.deps.reportFailure?.(
        `Finished chats were not delivered to the Manager: ${reason}. Patch will try again.`,
      );
    }
  }

  /**
   * A steady tick. Batched: delivers once the interval has passed and
   * something finished. Each one: retries chats held back by a delivery in
   * flight, a failed one or an offline home host.
   */
  tick(): boolean {
    if (this.isOff()) {
      this.clearPending();
      return false;
    }
    const settings = this.deps.settings();
    // A failed delivery's chats go again when the pause is over, not at the next interval.
    if (settings.managerWake === 'batched' && this.retryAfter === undefined) {
      const intervalMs = settings.managerWakeIntervalMinutes * 60_000;
      if (this.now() - this.lastDeliveryAt < intervalMs) return false;
    }
    return this.attempt();
  }

  /** Deliver what has finished so far, now (`patch threads send-finished`). */
  sendNow(): boolean {
    return this.attempt(true);
  }

  onResult(
    event: Pick<ManagerFinishedResultEvent, 'runId' | 'delivered' | 'error' | 'recorded'>,
  ): void {
    if (this.inFlight?.runId !== event.runId) {
      this.deps.logger.warn(
        { runId: event.runId },
        'manager-finished: a result for a delivery no longer waited on',
      );
      return;
    }
    if (event.error !== undefined) {
      this.deps.logger.warn(
        { runId: event.runId, error: event.error },
        'manager-finished: delivery failed',
      );
      this.failed(event.error, event.recorded === true);
      return;
    }
    this.inFlight = undefined;
    this.retryAfter = undefined;
    this.failureReported = false;
    this.save();
    this.deps.logger.info(
      { runId: event.runId, delivered: event.delivered },
      'manager-finished: delivered',
    );
  }

  /** Test/diagnostics: the chats waiting for the next delivery. */
  pendingChats(): string[] {
    return [...this.pending];
  }
}

type ChatSummaryActivity = NonNullable<ChatStateEvent['activity']>;
