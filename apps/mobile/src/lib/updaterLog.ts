// Persistent updater log for the phone — the evidence that an update restarts
// the app once, never words a planned update as a lost connection, and that the
// install prompt does not come back afterwards. Same shape as the desktop shell's
// log (packages/desktop/src/updateLog.ts). Stays on the device, in MMKV.

import * as Updates from 'expo-updates';
import { store } from './credential';
import { mobileBuildInfo } from './buildInfo';

const LOG_KEY = 'patch.updaterLog.v1';
const MAX_ENTRIES = 300;

export type UpdaterLogEvent =
  | 'launch'
  | 'check'
  | 'fetched'
  | 'install-requested'
  | 'prompt-shown'
  | 'prompt-cleared'
  | 'banner'
  | 'error';

export interface UpdaterLogEntry {
  at: number;
  version: string;
  /** expo-updates id of the bundle running when this was written. */
  updateId: string | null;
  event: UpdaterLogEvent;
  /** Launches since the last install press (0 until one is pressed). */
  relaunches: number;
  detail: string;
}

/** Wording that must never describe a planned update. */
export const FORBIDDEN_UPDATE_WORDING = /lost connection|reconnecting|offline/i;

export function readUpdaterLog(): UpdaterLogEntry[] {
  const raw = store().getString(LOG_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as UpdaterLogEntry[];
  } catch (err) {
    const fresh: UpdaterLogEntry[] = [
      {
        at: Date.now(),
        version: 'unknown',
        updateId: null,
        event: 'error',
        relaunches: 0,
        detail: `updater log was unreadable and was reset: ${String(err)}`,
      },
    ];
    store().set(LOG_KEY, JSON.stringify(fresh));
    return fresh;
  }
}

export function clearUpdaterLog(): void {
  store().delete(LOG_KEY);
}

export function relaunchesSinceInstall(entries: UpdaterLogEntry[]): number {
  let lastPress = -1;
  entries.forEach((e, i) => {
    if (e.event === 'install-requested') lastPress = i;
  });
  if (lastPress === -1) return 0;
  return entries.slice(lastPress + 1).filter((e) => e.event === 'launch').length;
}

/** Problems visible at a glance: a double restart, or lost-connection wording. */
export function findUpdaterProblems(entries: UpdaterLogEntry[]): string[] {
  const problems: string[] = [];
  const n = relaunchesSinceInstall(entries);
  if (n > 1) problems.push(`restarted ${n} times after one install press`);
  for (const e of entries) {
    if (e.event === 'banner' && FORBIDDEN_UPDATE_WORDING.test(e.detail)) {
      problems.push(`planned update showed "${e.detail}"`);
    }
  }
  return problems;
}

export function logUpdater(
  event: UpdaterLogEvent,
  detail: string,
  at = Date.now(),
): UpdaterLogEntry {
  const entries = readUpdaterLog();
  const base = {
    at,
    version: mobileBuildInfo().version,
    updateId: Updates.updateId ?? null,
    event,
    detail,
  };
  const entry: UpdaterLogEntry = {
    ...base,
    relaunches: relaunchesSinceInstall([...entries, { ...base, relaunches: 0 }]),
  };
  store().set(LOG_KEY, JSON.stringify([...entries, entry].slice(-MAX_ENTRIES)));
  return entry;
}

/** Report what a prompt/banner said, or that it cleared. Logs only changes. */
export function logPromptChange(source: string, text: string | null): void {
  const entries = readUpdaterLog();
  const last = [...entries].reverse().find((e) => e.detail.startsWith(`${source}:`));
  const next = `${source}: ${text ?? 'cleared'}`;
  if (last?.detail === next) return;
  if (text === null && !last) return; // never shown, nothing to clear
  logUpdater(text === null ? 'prompt-cleared' : 'prompt-shown', next);
  if (text !== null) logUpdater('banner', text);
}

export function updaterLogText(entries: UpdaterLogEntry[] = readUpdaterLog()): string {
  return entries
    .map(
      (e) =>
        `${new Date(e.at).toISOString()}  ${e.version}  ${e.event}  relaunches=${e.relaunches}  ${e.detail}`,
    )
    .join('\n');
}
