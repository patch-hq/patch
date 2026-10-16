// Handing over to the phone (spec/09 § Handing over to the phone).
//
// A notification shown as a desktop toast is lost if the user walks away before
// seeing it. This remembers what was routed to the desktop, and the moment the
// user stops being at any computer (`isComputerActive` true → false) sends what
// they never opened as one push. Held in memory only: a restart forgets it.

import type { Logger } from 'pino';
import type { NotifyEvent } from '@patch/wire';
import { BATCH_NOTIFY_CHAT_ID } from '@patch/wire';
import type { PresenceTracker } from '../presence.js';

/** How far back a desktop notification is still worth handing over. */
export const HANDOVER_WINDOW_MS = 10 * 60_000;

/** How often the server looks for the user having gone idle; an `away` report is acted on at once. */
export const HANDOVER_CHECK_INTERVAL_MS = 5_000;

export interface HandoverEntry {
  event: NotifyEvent;
  at: number;
}

/** What the handover needs to know about a chat at the moment it would send. */
export interface HandoverChat {
  /** Shown in the combined push. */
  name: string;
  /** False once the chat is snoozed, archived or deleted. */
  live: boolean;
}

export interface PhoneHandoverDeps {
  logger: Logger;
  presence: PresenceTracker;
  accountId: () => string | undefined;
  /** Undefined means the chat no longer exists. */
  chat: (chatId: string) => HandoverChat | undefined;
  /** Sends the handover push: the one notification as it would have been, or the combined one. */
  send: (entries: HandoverEntry[], names: string[]) => Promise<void>;
  nowMs?: () => number;
}

export class PhoneHandover {
  private pending: HandoverEntry[] = [];
  private wasActive = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: PhoneHandoverDeps) {}

  private now(): number {
    return this.deps.nowMs ? this.deps.nowMs() : Date.now();
  }

  /** A notification was shown on the desktop. */
  record(event: NotifyEvent): void {
    const at = this.now();
    this.prune(at);
    this.pending.push({ event, at });
  }

  /** The user opened `chatId` on some surface: whatever was sent for it before now has been seen. */
  opened(chatId: string): void {
    const at = this.now();
    this.pending = this.pending.filter((e) => e.event.chatId !== chatId || e.at > at);
  }

  /** Look at presence now; hand over if the user has just left every computer. */
  check(): Promise<void> {
    const accountId = this.deps.accountId();
    if (!accountId) return Promise.resolve();
    const now = this.now();
    const active = this.deps.presence.isComputerActive(accountId, now);
    const left = this.wasActive && !active;
    this.wasActive = active;
    if (!left) return Promise.resolve();
    return this.handOver(now);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.check().catch((err: Error) =>
        this.deps.logger.error({ err: err.message }, 'handover to phone failed'),
      );
    }, HANDOVER_CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private prune(now: number): void {
    this.pending = this.pending.filter((e) => now - e.at <= HANDOVER_WINDOW_MS);
  }

  private async handOver(now: number): Promise<void> {
    this.prune(now);
    // Taken out before anything is sent: a notification is handed over at most once.
    const taken = this.pending;
    this.pending = [];
    const entries: HandoverEntry[] = [];
    const names: string[] = [];
    for (const e of taken) {
      if (e.event.chatId === BATCH_NOTIFY_CHAT_ID) {
        entries.push(e);
        names.push('Batch');
        continue;
      }
      const chat = this.deps.chat(e.event.chatId);
      if (!chat?.live) {
        this.deps.logger.info(
          { chatId: e.event.chatId, gone: chat === undefined },
          'handover skipped: chat is snoozed, archived or deleted',
        );
        continue;
      }
      entries.push(e);
      if (!names.includes(chat.name)) names.push(chat.name);
    }
    if (entries.length === 0) return;
    this.deps.logger.info(
      { notifications: entries.length, chats: names },
      'handing over to the phone: the user left every computer',
    );
    await this.deps.send(entries, names);
  }
}
