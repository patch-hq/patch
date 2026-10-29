// In-memory presence tracker keyed by (accountId, surfaceId).
//
// Surfaces heartbeat every 10s (per spec/01). Connections that don't
// heartbeat within 30s are marked stale.
//
// Whether the user is AT A COMPUTER is a separate question, answered by input,
// not by heartbeats (spec/09 § Presence heuristic). A web or desktop window
// heartbeats whenever it is visible, which says nothing about whether anyone
// is sitting in front of it — a window left open on an empty desk used to hold
// every push back. Web and desktop surfaces report `surface.input` instead:
// the desktop app the whole host's idle time, a browser tab its own page's
// unless the user has granted idle detection. A report may also say the host
// is `away` (locked, asleep), which beats any idle time.

import type { SendToPhoneAfter } from '@patch/wire';

export type PresenceStatus = 'online' | 'stale' | 'offline';

/** What a surface knows about nobody being at the host. */
export type AwayReason = 'locked' | 'asleep';

export type InputScope = 'system' | 'page';

export type SurfaceKind = 'terminal' | 'web' | 'desktop' | 'mobile' | 'voice-device';

/**
 * What a client told us about its own build at hello time (spec/11 § Version
 * reporting). Recorded so `GET /api/version` can answer "what is my phone
 * actually running?" — the published artifact on the box says nothing about
 * whether a device ever installed it.
 *
 * `gitSha`/`builtAt` are absent on clients installed before build stamping
 * existed; absent means unknown, and the update panel renders it as unknown
 * rather than assuming current.
 */
export interface ClientBuildInfo {
  version: string;
  gitSha?: string;
  builtAt?: string;
}

export interface PresenceRecord {
  accountId: string;
  surfaceId: string;
  surfaceKind: SurfaceKind;
  status: PresenceStatus;
  lastHeartbeat: number;
  lastFocusedChatId?: string;
  /** Build the client reported at hello. Absent only for pre-check-in clients. */
  build?: ClientBuildInfo;
  /** When the user last touched this computer, per the surface's last `surface.input`. */
  lastInputAt?: number;
  /** When that report arrived — a surface that stops reporting says nothing. */
  inputReportedAt?: number;
  /** Whether the report covered the whole host or only this page. */
  inputScope?: InputScope;
  /** Set when the surface said nobody is at the host; cleared by the next report without it. */
  away?: AwayReason;
}

/** One computer's current presence, with the evidence it rests on (spec/09 § Presence heuristic). */
export interface ComputerPresence {
  surfaceId: string;
  surfaceKind: SurfaceKind;
  state: 'active' | 'idle' | 'away' | 'not-reporting';
  /** Time since input as of now, when the surface is reporting. */
  idleMs?: number;
  away?: AwayReason;
  scope?: InputScope;
}

/**
 * Wire shape returned by `GET /api/presence` (consumed by the CLI
 * `patch surfaces list`). Carries the surface `kind` (known at auth) plus a
 * derived `online` boolean so a live, heartbeating surface renders as online —
 * the CLI reads `surfaceKind`/`online`, not the internal `status` string.
 */
export interface PresenceView extends PresenceRecord {
  online: boolean;
}

export const PRESENCE_STALE_MS = 30_000;

/** Idle time that sends notifications to the phone, per `Send to my phone after`. `lock` never lets idle alone decide. */
export const AWAY_THRESHOLD_MS: Record<SendToPhoneAfter, number> = {
  '1m': 60_000,
  '5m': 300_000,
  lock: Number.POSITIVE_INFINITY,
};

/** A page can't see the host, so its idle time counts for more before it says anything. */
export const PAGE_SCOPE_THRESHOLD_MS = 300_000;

/** Surfaces report input every 15s; three missed reports and it is no evidence. */
export const INPUT_REPORT_STALE_MS = 45_000;

/** Surfaces whose presence is judged by input rather than by heartbeat. */
function isComputerSurface(kind: SurfaceKind): boolean {
  return kind === 'web' || kind === 'desktop';
}

function key(accountId: string, surfaceId: string): string {
  return `${accountId}::${surfaceId}`;
}

export class PresenceTracker {
  private readonly records = new Map<string, PresenceRecord>();

  constructor(private readonly opts: { sendToPhoneAfter?: () => SendToPhoneAfter } = {}) {}

  private thresholdMs(scope: InputScope | undefined): number {
    const setting = this.opts.sendToPhoneAfter?.() ?? '1m';
    const base = AWAY_THRESHOLD_MS[setting];
    return scope === 'page' && setting === '1m' ? PAGE_SCOPE_THRESHOLD_MS : base;
  }

  online(
    accountId: string,
    surfaceId: string,
    surfaceKind: SurfaceKind,
    nowMs: number = Date.now(),
    build?: ClientBuildInfo,
  ): void {
    const prev = this.records.get(key(accountId, surfaceId));
    // A second hello from a surface that is still connected (another window, a
    // reconnect overlapping the old socket) must not forget what it reported;
    // one arriving after it went offline is a new session and starts clean.
    const carried = prev !== undefined && prev.status !== 'offline' ? prev : undefined;
    this.records.set(key(accountId, surfaceId), {
      ...carried,
      accountId,
      surfaceId,
      surfaceKind,
      status: 'online',
      lastHeartbeat: nowMs,
      ...(build ? { build } : carried?.build ? { build: carried.build } : {}),
    });
  }

  offline(accountId: string, surfaceId: string): void {
    const k = key(accountId, surfaceId);
    const r = this.records.get(k);
    if (!r) return;
    this.records.set(k, { ...r, status: 'offline' });
  }

  drop(accountId: string, surfaceId: string): void {
    this.records.delete(key(accountId, surfaceId));
  }

  heartbeat(accountId: string, surfaceId: string, nowMs: number = Date.now()): void {
    const k = key(accountId, surfaceId);
    const r = this.records.get(k);
    if (!r) {
      // Unknown surface — caller must call online() first. NO FALLBACK.
      throw new Error(`PresenceTracker.heartbeat: unknown surface ${surfaceId}`);
    }
    this.records.set(k, { ...r, status: 'online', lastHeartbeat: nowMs });
  }

  /** Record a `surface.input` report: the user last touched this computer `idleMs` ago. */
  input(
    accountId: string,
    surfaceId: string,
    idleMs: number,
    nowMs: number = Date.now(),
    extra: { scope?: InputScope; away?: AwayReason } = {},
  ): void {
    const k = key(accountId, surfaceId);
    const r = this.records.get(k);
    if (!r) {
      throw new Error(`PresenceTracker.input: unknown surface ${surfaceId}`);
    }
    const { away: _prevAway, ...rest } = r;
    void _prevAway;
    this.records.set(k, {
      ...rest,
      lastInputAt: nowMs - idleMs,
      inputReportedAt: nowMs,
      inputScope: extra.scope ?? 'system',
      ...(extra.away ? { away: extra.away } : {}),
    });
  }

  setFocus(accountId: string, surfaceId: string, chatId: string | null): void {
    const k = key(accountId, surfaceId);
    const r = this.records.get(k);
    if (!r) {
      throw new Error(`PresenceTracker.setFocus: unknown surface ${surfaceId}`);
    }
    if (chatId === null) {
      const { lastFocusedChatId: _ignored, ...rest } = r;
      void _ignored;
      this.records.set(k, rest);
    } else {
      this.records.set(k, { ...r, lastFocusedChatId: chatId });
    }
  }

  /** Mark records as `stale` if their last heartbeat is older than `staleMs`. */
  sweep(nowMs: number = Date.now(), staleMs: number = PRESENCE_STALE_MS): void {
    for (const [k, r] of this.records.entries()) {
      if (r.status === 'online' && nowMs - r.lastHeartbeat > staleMs) {
        this.records.set(k, { ...r, status: 'stale' });
      }
    }
  }

  get(accountId: string, surfaceId: string): PresenceRecord | undefined {
    return this.records.get(key(accountId, surfaceId));
  }

  /**
   * spec/09 ## Presence heuristic — true when the user is somewhere a chat is
   * already in front of them: at a computer (see `isComputerActive`), or on a
   * phone with Patch open. Used by the push router to hold back an ordinary
   * push.
   */
  isActive(accountId: string, nowMs: number = Date.now()): boolean {
    if (this.isComputerActive(accountId, nowMs)) return true;
    for (const r of this.records.values()) {
      if (r.accountId !== accountId) continue;
      if (isComputerSurface(r.surfaceKind)) continue;
      if (r.status === 'offline') continue;
      if (nowMs - r.lastHeartbeat <= PRESENCE_STALE_MS) return true;
    }
    return false;
  }

  /**
   * spec/09 ## Presence heuristic — true when some web or desktop surface
   * reported within 45s, did not say the host is away, and has been idle for
   * less than the `Send to my phone after` threshold. A visible window on its
   * own is not enough — only input says someone is there. The terminal never
   * reports, so it never counts.
   */
  isComputerActive(accountId: string, nowMs: number = Date.now()): boolean {
    return this.computers(accountId, nowMs).some((c) => c.state === 'active');
  }

  /** Every web and desktop surface's presence, with the evidence for it. */
  computers(accountId: string, nowMs: number = Date.now()): ComputerPresence[] {
    const out: ComputerPresence[] = [];
    for (const r of this.records.values()) {
      if (r.accountId !== accountId) continue;
      if (!isComputerSurface(r.surfaceKind)) continue;
      out.push(this.presenceOf(r, nowMs));
    }
    return out;
  }

  /** One surface's presence; a surface the tracker has never heard of is not reporting. */
  computerOf(
    accountId: string,
    surfaceId: string,
    surfaceKind: SurfaceKind,
    nowMs: number = Date.now(),
  ): ComputerPresence {
    const r = this.records.get(key(accountId, surfaceId));
    return r ? this.presenceOf(r, nowMs) : { surfaceId, surfaceKind, state: 'not-reporting' };
  }

  private presenceOf(r: PresenceRecord, nowMs: number): ComputerPresence {
    const base = { surfaceId: r.surfaceId, surfaceKind: r.surfaceKind };
    if (
      r.status === 'offline' ||
      r.lastInputAt === undefined ||
      r.inputReportedAt === undefined ||
      nowMs - r.inputReportedAt > INPUT_REPORT_STALE_MS
    ) {
      return { ...base, state: 'not-reporting' };
    }
    const scope = r.inputScope ?? 'system';
    if (r.away) return { ...base, state: 'away', away: r.away, scope };
    const idleMs = Math.max(0, nowMs - r.lastInputAt);
    const state = idleMs < this.thresholdMs(scope) ? 'active' : 'idle';
    return { ...base, state, idleMs, scope };
  }

  /**
   * Presence rows for the wire (`GET /api/presence`). Each row carries
   * `surfaceKind` and a derived `online` boolean (true iff status is 'online'),
   * so the CLI can render kind/online without re-deriving from `status`.
   */
  snapshot(): PresenceView[] {
    return Array.from(this.records.values()).map((r) => ({ ...r, online: r.status === 'online' }));
  }
}
