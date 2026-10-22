// Manager placement (spec/06 § Manager failover).
//
// The server decides which host runs the Manager; no host is special. When that
// host has been offline for a while and another host is up, the server moves
// the Manager there for good, giving the new host the recent conversation from
// the server's own copy so the Manager can pick up where it left off. The host
// that was running it is told to let go whenever it next attaches; it is not
// handed the Manager back on return.
//
// The Manager's messages keep one sequence across hosts: the new host numbers
// its messages from where the server's copy ends. Each host's own log misses
// the stretches other hosts ran, so those are answered from the server's copy
// (`gapEvents`).

import { parsePersisted } from './persisted-json.js';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { headCodePoints, tailCodePoints, SPECIAL_THREAD_IDS, type WireEvent } from '@patch/wire';
import type { ChatLogStore } from './chat-log-store.js';

/** How long the Manager's host must be offline before another host takes over. */
export const FAILOVER_GRACE_MS = 120_000;

const MESSAGE_CHARS = 2_000;
const HANDOFF_CHARS = 24_000;
const SERVER_SURFACE = '_server';

/** A stretch of the Manager's transcript that `host` ran (`to` null while it still does). */
interface Run {
  host: string;
  from: number;
  to: number | null;
}

interface HostOrder {
  kind: 'adopt' | 'release';
  event: WireEvent;
}

interface State {
  epoch: number;
  runs: Run[];
  orders: Record<string, HostOrder>;
}

export interface ManagerFailoverDeps {
  /** The host the registry has running the Manager. */
  managerHostId: () => string | null;
  /** Make `hostId` the host running the Manager. */
  setManagerHostId: (hostId: string) => void;
  /** Tell every host and surface the Manager has moved. */
  onMoved: (hostId: string) => void;
  registeredHostIds: () => string[];
  isOnline: (hostId: string) => boolean;
  onHostStatus: (handler: (hostId: string, status: 'online' | 'offline') => void) => () => void;
  sendTo: (hostId: string, surfaceId: string, event: WireEvent) => void;
  log: Pick<ChatLogStore, 'read'>;
  /** How many messages of the conversation to hand over. */
  contextWindow: () => number;
  dataDir?: string;
  logger: Pick<Logger, 'info' | 'warn'>;
  graceMs?: number;
}

export class ManagerFailover {
  private state: State = { epoch: 0, runs: [], orders: {} };
  private readonly path: string | null;
  private readonly graceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: ManagerFailoverDeps) {
    this.graceMs = deps.graceMs ?? FAILOVER_GRACE_MS;
    this.path = deps.dataDir ? join(deps.dataDir, 'manager-failover.json') : null;
    this.load();
  }

  /** Begin watching host presence. */
  start(): void {
    this.unsubscribe = this.deps.onHostStatus((hostId, status) => this.onStatus(hostId, status));
    // A server restart while the Manager's host was already down.
    if (this.managerOffline()) this.armTimer();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTimer();
  }

  /** The host that owns the Manager and Speakers right now. */
  specialThreadHost(): string | null {
    return this.deps.managerHostId();
  }

  /**
   * The Manager's events after `fromSeq` that the current Manager host's own
   * log is missing: the stretches other hosts ran. Empty before any move.
   */
  gapEvents(fromSeq: number): WireEvent[] {
    if (this.state.runs.length === 0) return [];
    const current = this.deps.managerHostId();
    return this.deps.log.read(SPECIAL_THREAD_IDS.manager, fromSeq).filter((e) => {
      const seq = (e as { seq: number }).seq;
      return this.state.runs.some(
        (r) => r.host !== current && seq >= r.from && (r.to === null || seq <= r.to),
      );
    });
  }

  private onStatus(hostId: string, status: 'online' | 'offline'): void {
    const manager = this.deps.managerHostId();
    if (status === 'online') {
      // A host that missed an order while it was away is told again; it acts on
      // each order once.
      const order = this.state.orders[hostId];
      if (order) this.deps.sendTo(hostId, SERVER_SURFACE, order.event);
      if (hostId === manager) this.clearTimer();
      else if (this.managerOffline()) this.armTimer();
      return;
    }
    if (hostId === manager) this.armTimer();
  }

  private managerOffline(): boolean {
    const manager = this.deps.managerHostId();
    return manager !== null && !this.deps.isOnline(manager);
  }

  private armTimer(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.managerOffline()) this.activate();
    }, this.graceMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private maxSeq(): number {
    const events = this.deps.log.read(SPECIAL_THREAD_IDS.manager, -1);
    const last = events.at(-1) as { seq: number } | undefined;
    return last ? last.seq : -1;
  }

  private activate(): void {
    const previous = this.deps.managerHostId();
    const candidate = this.deps
      .registeredHostIds()
      .find((id) => id !== previous && this.deps.isOnline(id));
    if (previous === null || candidate === undefined) {
      this.deps.logger.warn(
        {},
        'manager-failover: the Manager host is offline and no other host is up',
      );
      return;
    }
    const last = this.maxSeq();
    const nextSeq = last + 1;
    // The first move: the original host ran everything so far.
    if (this.state.runs.length === 0) {
      this.state.runs.push({ host: previous, from: 0, to: last });
    } else {
      const open = this.state.runs.at(-1);
      if (open && open.to === null) open.to = last;
    }
    this.state.runs.push({ host: candidate, from: nextSeq, to: null });
    this.state.epoch += 1;
    const adopt: WireEvent = {
      type: 'host.manager_adopt',
      hostId: candidate,
      epoch: this.state.epoch,
      handoff: this.handoffText(-1, 'the machine that was running you is offline'),
      nextSeq,
    };
    this.state.orders[candidate] = { kind: 'adopt', event: adopt };
    this.state.orders[previous] = {
      kind: 'release',
      event: { type: 'host.manager_release', hostId: previous, epoch: this.state.epoch },
    };
    this.deps.setManagerHostId(candidate);
    this.save();
    this.deps.logger.info(
      { hostId: candidate, previous, epoch: this.state.epoch },
      'manager-failover: Manager moved',
    );
    this.deps.sendTo(candidate, SERVER_SURFACE, adopt);
    if (this.deps.isOnline(previous)) {
      this.deps.sendTo(previous, SERVER_SURFACE, this.state.orders[previous]!.event);
    }
    this.deps.onMoved(candidate);
  }

  private handoffText(afterSeq: number, why: string): string {
    const lines: string[] = [];
    for (const e of this.deps.log.read(SPECIAL_THREAD_IDS.manager, afterSeq)) {
      if (e.type !== 'chat.message' || e.role === 'system') continue;
      lines.push(`${e.role}: ${headCodePoints(e.content, MESSAGE_CHARS)}`);
    }
    const recent = lines.slice(-this.deps.contextWindow());
    const body = tailCodePoints(recent.join('\n\n'), HANDOFF_CHARS);
    return (
      `[handoff] You are the Manager, and ${why}. This is the recent conversation, oldest first, ` +
      `for you to carry on from:\n\n${body === '' ? '(nothing yet)' : body}`
    );
  }

  private load(): void {
    if (this.path === null || !existsSync(this.path)) return;
    try {
      this.state = { ...this.state, ...(parsePersisted(readFileSync(this.path, 'utf8')) as State) };
    } catch (err) {
      this.deps.logger.warn({ err }, 'manager-failover: could not read its state; starting clean');
    }
  }

  private save(): void {
    if (this.path === null) return;
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.path);
    } catch (err) {
      this.deps.logger.warn({ err }, 'manager-failover: could not write its state');
    }
  }
}
