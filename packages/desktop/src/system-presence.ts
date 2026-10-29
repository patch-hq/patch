// What this host can say about nobody being at it (spec/09 § Presence
// heuristic). Input idle time answers "has someone touched it lately"; this adds
// the cases where the host knows better than the clock: the screen is locked,
// the session is switched out, or the host is going to sleep (a closed lid
// included).

export type Away = 'locked' | 'asleep';

export interface SystemPresenceReport {
  /** Milliseconds since the last input anywhere on the host. */
  idleMs: number;
  /** Set while nobody is at the host. */
  away?: Away;
}

/** The slice of Electron's `powerMonitor` this needs. */
export interface PowerMonitorLike {
  on(event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume', listener: () => void): unknown;
  getSystemIdleTime(): number;
  getSystemIdleState(idleThreshold: number): 'active' | 'idle' | 'locked' | 'unknown';
}

export class SystemPresence {
  private locked = false;
  private asleep = false;

  /** `onAwayChange` fires whenever `away` may have changed, so the renderer reports at once. */
  constructor(
    private readonly monitor: PowerMonitorLike,
    private readonly onAwayChange: () => void,
  ) {}

  /** `lock-screen`/`unlock-screen` fire on macOS and Windows, `suspend`/`resume` on all three. */
  start(): void {
    this.monitor.on('lock-screen', () => this.set({ locked: true }));
    this.monitor.on('unlock-screen', () => this.set({ locked: false }));
    this.monitor.on('suspend', () => this.set({ asleep: true }));
    this.monitor.on('resume', () => this.set({ asleep: false }));
  }

  private set(next: { locked?: boolean; asleep?: boolean }): void {
    this.locked = next.locked ?? this.locked;
    this.asleep = next.asleep ?? this.asleep;
    this.onAwayChange();
  }

  read(): SystemPresenceReport {
    const idleMs = this.monitor.getSystemIdleTime() * 1000;
    // The OS's own answer covers a session that locks without the event (some
    // Linux desktops) or was already locked when Patch started.
    const away: Away | undefined = this.asleep
      ? 'asleep'
      : this.locked || this.monitor.getSystemIdleState(60) === 'locked'
        ? 'locked'
        : undefined;
    return away ? { idleMs, away } : { idleMs };
  }
}
