// Messages a surface sent to a chat whose host was offline (spec/04 § Host,
// spec/12 § Host-offline UX). The server holds them and delivers them when the
// host reconnects. Held in memory alone, a server restart would lose every one,
// so each is also written to `<dataDir>/held-input.json` and put back on boot.
//
// Only a person's message is held this way (`chat.input`). Every other frame a
// surface sends to an offline host is a control the surface sends again when it
// matters.
//
// A message held past `HELD_INPUT_MAX_AGE_MS` is not delivered, and it is never
// dropped in silence either (spec/12 § Host-offline UX). On expiry it is
// replaced by a `chat.held_input_expired` notice, held for the same host, so
// the chat's own writer records the failure in the chat when it returns; and
// `onExpired` lets the server tell surfaces now. A timer is armed for the
// soonest expiry, so this happens at the time rather than on the next write.

import { parsePersisted } from './persisted-json.js';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { HELD_INPUT_MAX_AGE_MS, type ChatHeldInputExpiredEvent, type WireEvent } from '@patch/wire';

/** A message nobody picked up for this long is not what the sender wants delivered now. */
export { HELD_INPUT_MAX_AGE_MS };

export interface HeldInput {
  hostId: string;
  surfaceId: string;
  event: WireEvent;
  at: number;
}

/** One held message that reached its expiry, and the notice now held in its place. */
export interface ExpiredHeldInput {
  expired: HeldInput;
  notice: HeldInput & { event: ChatHeldInputExpiredEvent };
}

export interface HeldInputStoreOptions {
  /** Where `held-input.json` lives. Absent keeps the messages in memory only. */
  dataDir?: string;
  logger: Pick<Logger, 'warn'>;
  now?: () => number;
  /**
   * Called with the messages that have just expired. May be set after
   * construction (`setOnExpired`), and is then called at once for anything that
   * expired while the server was down.
   */
  onExpired?: (expired: ExpiredHeldInput[]) => void;
  /** A host's name, for the notice that replaces an expired message. */
  hostName?: (hostId: string) => string | undefined;
}

/** setTimeout's signed-32-bit ceiling (~24.8 days). */
const MAX_TIMEOUT_MS = 2_147_483_000;

export class HeldInputStore {
  private readonly path: string | null;
  private readonly logger: Pick<Logger, 'warn'>;
  private readonly now: () => number;
  private held: HeldInput[] = [];
  private onExpired: ((expired: ExpiredHeldInput[]) => void) | undefined;
  private readonly hostName: (hostId: string) => string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: HeldInputStoreOptions) {
    this.logger = opts.logger;
    this.now = opts.now ?? (() => Date.now());
    this.onExpired = opts.onExpired;
    this.hostName = opts.hostName ?? (() => undefined);
    this.path = opts.dataDir ? join(opts.dataDir, 'held-input.json') : null;
    if (this.path !== null && existsSync(this.path)) {
      try {
        const parsed: unknown = parsePersisted(readFileSync(this.path, 'utf8'));
        if (Array.isArray(parsed)) this.held = parsed as HeldInput[];
      } catch (err) {
        // NO FALLBACK: say so, then start empty rather than guess at a damaged file.
        this.logger.warn({ err }, 'held-input: could not read the held messages; starting empty');
      }
    }
  }

  /**
   * Who is told when a message expires. Runs the expiry check at once unless
   * `checkNow` is false, in which case only the timer is armed and the caller
   * runs `expireDue` when everything it tells is ready (the server at boot).
   */
  setOnExpired(
    handler: (expired: ExpiredHeldInput[]) => void,
    opts: { checkNow?: boolean } = {},
  ): void {
    this.onExpired = handler;
    if (opts.checkNow === false) this.arm();
    else this.prune();
  }

  /** Expire anything past its holding time now. */
  expireDue(): void {
    this.prune();
  }

  /** Everything held, as it stands, without running the expiry check (boot). */
  snapshot(): HeldInput[] {
    return [...this.held];
  }

  /** Messages still worth delivering, oldest first. */
  all(): HeldInput[] {
    this.prune();
    return [...this.held];
  }

  add(hostId: string, surfaceId: string, event: WireEvent): void {
    this.prune();
    this.held.push({ hostId, surfaceId, event, at: this.now() });
    this.save();
    // Armed after the push: the check above ran before this message was held.
    this.arm();
  }

  /** The host took everything held for it, or the message was delivered another way. */
  clearHost(hostId: string): void {
    const before = this.held.length;
    this.prune();
    this.held = this.held.filter((h) => h.hostId !== hostId);
    if (this.held.length !== before) this.save();
  }

  /**
   * Expire what has waited past the limit: each such message is replaced by a
   * notice for its host and reported, then the timer is armed for the next one.
   * A notice does not expire; it goes when the host takes it, or with the host.
   */
  private prune(): void {
    const cutoff = this.now() - HELD_INPUT_MAX_AGE_MS;
    const expired: ExpiredHeldInput[] = [];
    this.held = this.held.map((h) => {
      if (h.event.type !== 'chat.input' || h.at >= cutoff) return h;
      const notice = {
        hostId: h.hostId,
        surfaceId: h.surfaceId,
        at: this.now(),
        event: {
          type: 'chat.held_input_expired' as const,
          chatId: h.event.chatId,
          text: h.event.message,
          heldAt: h.at,
          hostName: this.hostName(h.hostId) ?? h.hostId,
        },
      };
      expired.push({ expired: h, notice });
      return notice;
    });
    if (expired.length > 0) {
      this.logger.warn(
        { count: expired.length, chats: expired.map((e) => e.notice.event.chatId) },
        'held-input: messages for an offline host expired undelivered; the chats are told',
      );
      this.save();
      this.onExpired?.(expired);
    }
    this.arm();
  }

  /** Arm one timer for the soonest message still to expire. */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let soonest: number | undefined;
    for (const h of this.held) {
      if (h.event.type !== 'chat.input') continue;
      const at = h.at + HELD_INPUT_MAX_AGE_MS;
      if (soonest === undefined || at < soonest) soonest = at;
    }
    if (soonest === undefined) return;
    const delay = Math.min(Math.max(0, soonest - this.now()) + 1, MAX_TIMEOUT_MS);
    this.timer = setTimeout(() => this.prune(), delay);
    this.timer.unref?.();
  }

  /** Stop the expiry timer (server shutdown, tests). */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private save(): void {
    if (this.path === null) return;
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.held));
      renameSync(tmp, this.path);
    } catch (err) {
      this.logger.warn({ err }, 'held-input: could not write the held messages');
    }
  }
}
