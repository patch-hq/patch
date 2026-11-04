// On-device exit log: why did the app stop?
//
// Everything here stays on the phone, in MMKV, and is shown in Settings ->
// Updates -> "Exits" so the user can read it, copy it and clear it. Nothing
// leaves the device unless the user turns on "Share crash reports"
// (`telemetryEnabled`, off by default); only then do crashes and unexplained
// exits go to the paired server (crashReport.ts).
//
// Android gives a JS app no "I am being killed" callback, so an exit is found
// on the NEXT launch from a session marker written while running: the app's
// foreground/background state, a heartbeat, the build and OTA update id. A
// marker still saying "foreground" with no crash and no restart the user asked
// for means the app stopped while in use for a reason we did not see (system
// kill, native abort). A changed build or update id says an update was applied.

import { AppState } from 'react-native';
import * as Updates from 'expo-updates';
import { store } from './credential';
import { mobileBuildInfo } from './buildInfo';

const LOG_KEY = 'patch.exitLog.v1';
const SESSION_KEY = 'patch.exitSession.v1';
const SHARE_KEY = 'patch.shareCrashReports.v1';
const MAX_ENTRIES = 100;
const HEARTBEAT_MS = 30_000;

export type ExitKind = 'crash' | 'unexpected-exit' | 'restart' | 'updated' | 'closed';

export interface ExitEntry {
  at: number;
  kind: ExitKind;
  /** One plain sentence, free of chat content. */
  detail: string;
}

interface Session {
  startedAt: number;
  lastSeenAt: number;
  state: 'active' | 'background';
  build: string;
  updateId: string | null;
  /** Set when the session ended for a reason we already know. */
  endedBy?: 'crash' | 'restart';
}

/** Off by default: nothing is sent anywhere until the user turns this on. */
export function telemetryEnabled(): boolean {
  return store().getBoolean(SHARE_KEY) === true;
}

export function setTelemetryEnabled(on: boolean): void {
  store().set(SHARE_KEY, on);
}

export function readExitLog(): ExitEntry[] {
  const raw = store().getString(LOG_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ExitEntry[];
  } catch (err) {
    // Our own log is corrupt: say so in the log itself and start again.
    const fresh: ExitEntry[] = [
      {
        at: Date.now(),
        kind: 'closed',
        detail: `exit log was unreadable and was reset: ${String(err)}`,
      },
    ];
    store().set(LOG_KEY, JSON.stringify(fresh));
    return fresh;
  }
}

export function clearExitLog(): void {
  store().delete(LOG_KEY);
}

export function logExit(kind: ExitKind, detail: string, at = Date.now()): ExitEntry {
  const entry: ExitEntry = { at, kind, detail };
  store().set(LOG_KEY, JSON.stringify([...readExitLog(), entry].slice(-MAX_ENTRIES)));
  return entry;
}

/** The log as text, for the user to copy or share by hand. */
export function exitLogText(entries: ExitEntry[] = readExitLog()): string {
  return entries.map((e) => `${new Date(e.at).toISOString()}  ${e.kind}  ${e.detail}`).join('\n');
}

function readSession(): Session | null {
  const raw = store().getString(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch (err) {
    logExit('closed', `session marker was unreadable and was reset: ${String(err)}`);
    return null;
  }
}

function writeSession(patch: Partial<Session>): void {
  const current = readSession();
  if (!current) throw new Error('exit log: no session started');
  store().set(SESSION_KEY, JSON.stringify({ ...current, ...patch }));
}

function currentBuild(): string {
  const info = mobileBuildInfo();
  return `${info.version}${info.gitSha ? `+${info.gitSha}` : ''}`;
}

/** The user pressed a restart (Updates.reloadAsync): that ending is expected. */
export function noteIntentionalRestart(): void {
  logExit('restart', 'restarted from Settings to apply an update');
  writeSession({ endedBy: 'restart' });
}

/** A crash was caught this session; the next launch should not call it unexplained. */
export function noteCrashed(): void {
  if (readSession()) writeSession({ endedBy: 'crash' });
}

export interface LaunchFinding {
  entry: ExitEntry | null;
  /** True when the previous run stopped in use for a reason we did not see. */
  unexplained: boolean;
}

/**
 * Compare the previous run's marker with this launch, log what it shows, and
 * start the marker for this run. Call once, first thing at startup.
 */
export function beginSession(now = Date.now()): LaunchFinding {
  const previous = readSession();
  const build = currentBuild();
  const updateId = Updates.updateId ?? null;
  let finding: LaunchFinding = { entry: null, unexplained: false };

  if (previous) {
    const changed = previous.build !== build || previous.updateId !== updateId;
    if (changed) {
      finding = {
        entry: logExit('updated', `now running ${build}; previous run was ${previous.build}`, now),
        unexplained: false,
      };
    }
    if (!previous.endedBy && previous.state === 'active') {
      const since = Math.round((now - previous.lastSeenAt) / 1000);
      const during = changed ? ' (an update was applied between runs)' : '';
      finding = {
        entry: logExit(
          'unexpected-exit',
          `stopped while open, no crash recorded; last seen ${since}s before relaunch${during}`,
          now,
        ),
        unexplained: true,
      };
    }
  }

  store().set(
    SESSION_KEY,
    JSON.stringify({
      startedAt: now,
      lastSeenAt: now,
      state: 'active',
      build,
      updateId,
    } satisfies Session),
  );
  return finding;
}

/** Keep the marker current while the app runs. Returns a teardown. */
export function trackSession(): () => void {
  const sub = AppState.addEventListener('change', (next) => {
    writeSession({
      state: next === 'active' ? 'active' : 'background',
      lastSeenAt: Date.now(),
    });
  });
  const timer = setInterval(() => {
    if (AppState.currentState === 'active') writeSession({ lastSeenAt: Date.now() });
  }, HEARTBEAT_MS);
  return () => {
    sub.remove();
    clearInterval(timer);
  };
}
