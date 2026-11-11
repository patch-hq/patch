import { execFile } from 'node:child_process';
import { descendantsOf } from './terminal.js';

/** One row of `ps -A -o pid=,ppid=,args=`. */
export interface PsRow {
  pid: number;
  ppid: number;
  args: string;
}

export function parsePsRows(psOutput: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of psOutput.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] as string });
  }
  return rows;
}

const SHELL_C = /(^|\/)(bash|zsh|sh|dash)\s(.*\s)?-\w*c\b/;

/**
 * A piece of the command that survives the quoting Claude Code wraps it in
 * (`eval '<command>'`): the first non-blank line, up to the first quote.
 */
export function commandFingerprint(command: string): string {
  const line = command.split('\n').find((l) => l.trim() !== '') ?? '';
  return (line.split("'")[0] ?? '').trim().slice(0, 80);
}

/**
 * The shell Claude Code started for one Bash call: a `<shell> -c` process
 * below claude carrying the call's command, outermost first so a `bash -c`
 * the command itself started is never taken for the call. Null when no
 * process matches — the call already finished, or the command cannot be told
 * apart from a sibling — and the caller says so rather than guessing.
 */
export function findBashShell(
  rows: readonly PsRow[],
  claudePid: number,
  command: string,
): number | null {
  const below = new Set(descendantsOf(rows.map((r) => `${r.pid} ${r.ppid}`).join('\n'), claudePid));
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const shells = rows.filter((r) => below.has(r.pid) && SHELL_C.test(r.args));
  const shellPids = new Set(shells.map((r) => r.pid));
  const outer = shells.filter((r) => {
    for (let p = byPid.get(r.ppid); p; p = byPid.get(p.ppid)) {
      if (shellPids.has(p.pid)) return false;
    }
    return true;
  });
  const fingerprint = commandFingerprint(command);
  const matching = fingerprint === '' ? outer : outer.filter((r) => r.args.includes(fingerprint));
  return matching.length === 1 ? (matching[0] as PsRow).pid : null;
}

/** What a cancel signalled: the call's descendants, or the shell itself when it has none. */
export function cancelTargets(rows: readonly PsRow[], shellPid: number): number[] {
  const kids = descendantsOf(rows.map((r) => `${r.pid} ${r.ppid}`).join('\n'), shellPid);
  return kids.length > 0 ? kids : [shellPid];
}

/**
 * SIGINT one Bash call of the claude process `claudePid`. Never signals claude
 * or its MCP servers. Resolves the pids signalled; rejects when the call's
 * shell cannot be found.
 */
export function cancelBashCall(claudePid: number, command: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-A', '-ww', '-o', 'pid=,ppid=,args='],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        /* v8 ignore next 4 -- `ps` is present on every host. */
        if (err) {
          reject(err);
          return;
        }
        const rows = parsePsRows(stdout);
        const shell = findBashShell(rows, claudePid, command);
        if (shell === null) {
          reject(new Error('no running Bash call matches that command'));
          return;
        }
        const targets = cancelTargets(rows, shell);
        for (const pid of targets) {
          try {
            process.kill(pid, 'SIGINT');
          } catch {
            // Gone between the listing and the signal: it has stopped, which is the point.
          }
        }
        resolve(targets);
      },
    );
  });
}
