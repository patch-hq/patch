// Persistent updater log — the evidence for "an update restarts once, says
// nothing about a lost connection, and the Update Patch prompt does not come
// back". Without it none of that can be checked after the fact.
//
// One JSON object per line in userData/update-log.jsonl, newest last, bounded.
// Every entry carries the running version and the relaunch count so a single
// read answers "how many times did the shell start after the install press?".

export type UpdateLogEvent =
  | 'launch'
  | 'check'
  | 'available'
  | 'downloaded'
  | 'install-requested'
  | 'install-error'
  | 'prompt-shown'
  | 'prompt-cleared'
  | 'banner';

export interface UpdateLogEntry {
  at: string;
  /** Version of the running shell when this was written. */
  version: string;
  event: UpdateLogEvent;
  /** Launches since the last install press (0 until one is pressed). */
  relaunches: number;
  /** Event detail: target version, error text, or the banner wording shown. */
  detail: string;
}

export const MAX_LOG_ENTRIES = 500;

/** Wording that must never describe a planned update. */
export const FORBIDDEN_UPDATE_WORDING = /lost connection|reconnecting|offline/i;

/** Parse the file. Corrupt lines are kept as a visible entry, not dropped. */
export function parseUpdateLog(raw: string): UpdateLogEntry[] {
  const out: UpdateLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as UpdateLogEntry);
    } catch {
      out.push({
        at: new Date(0).toISOString(),
        version: 'unknown',
        event: 'check',
        relaunches: 0,
        detail: `unreadable log line: ${line.slice(0, 80)}`,
      });
    }
  }
  return out;
}

/** Launches recorded after the most recent install press. */
export function relaunchesSinceInstall(entries: UpdateLogEntry[]): number {
  let lastPress = -1;
  entries.forEach((e, i) => {
    if (e.event === 'install-requested') lastPress = i;
  });
  if (lastPress === -1) return 0;
  return entries.slice(lastPress + 1).filter((e) => e.event === 'launch').length;
}

/** Problems a reader should see at a glance: double restart, bad wording. */
export function findUpdateProblems(entries: UpdateLogEntry[]): string[] {
  const problems: string[] = [];
  if (relaunchesSinceInstall(entries) > 1) {
    problems.push(`restarted ${relaunchesSinceInstall(entries)} times after one install press`);
  }
  for (const e of entries) {
    if (e.event === 'banner' && FORBIDDEN_UPDATE_WORDING.test(e.detail)) {
      problems.push(`planned update showed "${e.detail}" at ${e.at}`);
    }
  }
  return problems;
}

export function buildEntry(
  entries: UpdateLogEntry[],
  version: string,
  event: UpdateLogEvent,
  detail: string,
  at: string,
): UpdateLogEntry {
  const base = { at, version, event, detail };
  const withThis = [...entries, { ...base, relaunches: 0 }];
  return { ...base, relaunches: relaunchesSinceInstall(withThis) };
}

/** Append and trim, writing via temp file + rename like the other persisted state. */
export function appendUpdateLog(
  file: string,
  version: string,
  event: UpdateLogEvent,
  detail: string,
  at: string,
  fs: {
    readFile: (path: string) => string | null;
    writeFile: (path: string, data: string) => void;
    rename: (from: string, to: string) => void;
  },
): UpdateLogEntry {
  const entries = parseUpdateLog(fs.readFile(file) ?? '');
  const entry = buildEntry(entries, version, event, detail, at);
  const kept = [...entries, entry].slice(-MAX_LOG_ENTRIES);
  const tmp = `${file}.tmp`;
  fs.writeFile(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.rename(tmp, file);
  return entry;
}
