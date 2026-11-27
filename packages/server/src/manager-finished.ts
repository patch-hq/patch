// Finished chats → the Manager (spec/06 § Finished chats).
//
// The server sees every host's chats, so it is the one that notices a chat
// finishing. It decides only which chats count and when a delivery is due
// (`managerWake`); the turn itself — reading each chat's last reply and
// sending one message into the Manager — is the Manager's home host's
// (`ChatRunner.deliverFinishedChats`).

import type { Logger } from 'pino';
import type { ChatStateEvent, ManagerFinishedChat, WireEvent } from '@patch/wire';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import type { ChatRegistry, ChatSummary } from './chat-registry.js';
import type { AccountSettings } from './settings.js';

/**
 * How long a delivery may go without its result before the collector stops
 * waiting for it (the host restarted mid-delivery). Reading a few chats'
 * history across hosts takes seconds; this is far past that.
 */
export const IN_FLIGHT_STALE_MS = 10 * 60_000;

const SPECIAL_IDS: ReadonlySet<string> = new Set(Object.values(SPECIAL_THREAD_IDS));

export interface ManagerFinishedDeps {
  chats: ChatRegistry;
  settings: () => AccountSettings;
  /** The Manager's home host when it is online, else undefined. */
  managerHostId: () => string | undefined;
  /** Ask the home host to deliver (fire-and-forget; the result arrives via `onResult`). */
  deliver: (req: { runId: string; chats: ManagerFinishedChat[]; windowMinutes?: number }) => void;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
  idGenerator?: () => string;
}

export class ManagerFinishedCollector {
  private readonly deps: ManagerFinishedDeps;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  /** Chats that finished since the last delivery, in the order they finished. */
  private readonly pending = new Set<string>();
  private readonly lastActivity = new Map<string, ChatSummary['activity']>();
  private lastDeliveryAt: number;
  /** Set while a delivery's result hasn't come back — one at a time. */
  private inFlightRunId: string | undefined;
  private inFlightSince = 0;

  constructor(deps: ManagerFinishedDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.idGenerator =
      deps.idGenerator ?? (() => `finished-${this.now()}-${Math.random().toString(36).slice(2)}`);
    // Boot counts as "just delivered", so the batch clock does not read as
    // overdue the moment the server starts.
    this.lastDeliveryAt = this.now();
  }

  /** Off: the setting is off, or the Manager is disabled. */
  private isOff(): boolean {
    return (
      this.deps.settings().managerWake === 'off' ||
      this.deps.chats.get(SPECIAL_THREAD_IDS.manager)?.disabled === true
    );
  }

  observe(event: WireEvent): void {
    if (event.type !== 'chat.state') return;
    this.observeState(event);
  }

  private observeState(event: ChatStateEvent): void {
    const chatId = event.chatId;
    const previous = this.lastActivity.get(chatId);
    if (event.activity !== undefined) this.lastActivity.set(chatId, event.activity);
    if (SPECIAL_IDS.has(chatId)) return;
    // It started working again before the delivery went: it has not finished.
    if (event.activity === 'running') {
      this.pending.delete(chatId);
      return;
    }
    // Off means nothing is collected, so no backlog floods in when it is turned on.
    if (this.isOff()) return;
    if (!(event.activity === 'idle' && previous === 'running' && event.turnStopped !== true)) {
      return;
    }
    if (!this.counts(chatId, event)) return;
    this.pending.add(chatId);
    if (this.deps.settings().managerWake === 'each') this.attempt();
  }

  /** Whether a chat that just went idle is one the Manager is told about. */
  private counts(chatId: string, event: ChatStateEvent): boolean {
    const chat = this.deps.chats.get(chatId);
    const status = event.status ?? chat?.status ?? 'active';
    if (status !== 'active') return false;
    const snoozedUntil = event.snoozedUntil ?? chat?.snoozedUntil ?? null;
    if (snoozedUntil !== null && snoozedUntil > this.now()) return false;
    if (event.hidden ?? chat?.hidden ?? false) return false;
    // A goal keeps the chat working on its own; it is not finished yet.
    const goal = event.goal !== undefined ? event.goal : (chat?.goal ?? null);
    if (goal !== null) return false;
    return true;
  }

  private toChat(chatId: string): ManagerFinishedChat | undefined {
    const chat = this.deps.chats.get(chatId);
    if (!chat || chat.status !== 'active') return undefined;
    // A goal set since it went idle: it is working again.
    if (chat.goal !== null) return undefined;
    return { chatId, hostId: chat.hostId, folder: chat.folder, name: chat.name ?? chat.folder };
  }

  private attempt(force = false): boolean {
    if (this.isOff()) {
      this.pending.clear();
      return false;
    }
    if (this.pending.size === 0) return false;
    if (this.inFlightRunId !== undefined) {
      if (this.now() - this.inFlightSince < IN_FLIGHT_STALE_MS) return false;
      this.deps.logger.warn(
        { runId: this.inFlightRunId },
        'manager-finished: delivery never reported back, no longer waiting for it',
      );
      this.inFlightRunId = undefined;
    }
    const hostId = this.deps.managerHostId();
    // Kept for when the home host is back.
    if (!hostId) return false;
    const settings = this.deps.settings();
    const chats = [...this.pending]
      .map((id) => this.toChat(id))
      .filter((c): c is ManagerFinishedChat => c !== undefined);
    this.pending.clear();
    this.lastDeliveryAt = this.now();
    if (chats.length === 0) return false;
    const runId = this.idGenerator();
    this.inFlightRunId = runId;
    this.inFlightSince = this.lastDeliveryAt;
    const batched = settings.managerWake === 'batched' && !force;
    this.deps.deliver({
      runId,
      chats,
      ...(batched ? { windowMinutes: settings.managerWakeIntervalMinutes } : {}),
    });
    this.deps.logger.info({ runId, chats: chats.length }, 'manager-finished: delivery requested');
    return true;
  }

  /**
   * A steady tick. Batched: delivers once the interval has passed and
   * something finished. Each one: retries chats held back by a delivery in
   * flight or an offline home host.
   */
  tick(): boolean {
    if (this.isOff()) {
      this.pending.clear();
      return false;
    }
    const settings = this.deps.settings();
    if (settings.managerWake === 'batched') {
      const intervalMs = settings.managerWakeIntervalMinutes * 60_000;
      if (this.now() - this.lastDeliveryAt < intervalMs) return false;
    }
    return this.attempt();
  }

  /** Deliver what has finished so far, now (`patch threads send-finished`). */
  sendNow(): boolean {
    return this.attempt(true);
  }

  onResult(event: { runId: string; delivered: number; error?: string }): void {
    if (this.inFlightRunId === event.runId) this.inFlightRunId = undefined;
    if (event.error !== undefined) {
      this.deps.logger.warn(
        { runId: event.runId, error: event.error },
        'manager-finished: delivery failed',
      );
    } else {
      this.deps.logger.info(
        { runId: event.runId, delivered: event.delivered },
        'manager-finished: delivered',
      );
    }
  }

  /** Test/diagnostics: the chats waiting for the next delivery. */
  pendingChats(): string[] {
    return [...this.pending];
  }
}
