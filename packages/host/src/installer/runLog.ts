// The installer's own log, written by the installer itself.
//
// A self-update runs the installer detached with its output pointed at
// ~/.patch/logs/self-update.log, but that only captures what the installer
// prints, and nothing at all if it is killed before it prints (the 14:06 run on
// 2026-11-07 left no trace). So the installer appends its own timestamped lines
// — synchronously, so a kill cannot lose them — for its start, each service
// manager step with the result, any signal that reaches it, and its exit code.

import { appendFileSync, fstatSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let logPath: string | undefined;

export function installerLogPath(home: string): string {
  return join(home, '.patch', 'logs', 'self-update.log');
}

/** Append one timestamped line. A no-op until `openInstallerLog` has run. */
export function installerLog(message: string): void {
  if (!logPath) return;
  appendFileSync(logPath, `${new Date().toISOString()} [installer ${process.pid}] ${message}\n`);
}

/** Redact the one secret an installer's command line can carry. */
export function redactArgs(argv: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    out.push(argv[i]!);
    if (argv[i] === '--internal-token' || argv[i] === '--code') {
      if (i + 1 < argv.length) out.push('<redacted>');
      i += 1;
    }
  }
  return out.join(' ');
}

/**
 * Start logging to `<home>/.patch/logs/self-update.log`. Returns whether the
 * installer's own stdout/stderr already point at that file (a self-update), in
 * which case printed lines must not be copied into it a second time.
 */
export function openInstallerLog(home: string, argv: readonly string[]): { stdioIsLog: boolean } {
  const path = installerLogPath(home);
  mkdirSync(join(home, '.patch', 'logs'), { recursive: true });
  logPath = path;
  let stdioIsLog = false;
  try {
    const ino = statSync(path).ino;
    stdioIsLog = fstatSync(1).ino === ino || fstatSync(2).ino === ino;
  } catch {
    stdioIsLog = false;
  }
  installerLog(
    `start: argv=${redactArgs(argv)} ppid=${process.ppid} node=${process.version} cwd=${process.cwd()}`,
  );
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
    process.on(sig, () => {
      installerLog(`received ${sig} — exiting`);
      process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const)[sig]);
    });
  }
  return { stdioIsLog };
}
