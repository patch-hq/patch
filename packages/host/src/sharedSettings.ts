// A host's half of the shared settings (spec/01 § Settings).
//
// The server owns every setting that is not tied to one machine and sends each
// host a `settings.snapshot`. This module holds the pieces of applying one that
// are not wiring: how a login this host already held is read back out so it can
// be sent to the server once.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The keyring entry name Codex keeps a CODEX_HOME's login under. */
export function codexKeyringUser(home: string): string {
  return `cli|${createHash('sha256').update(home).digest('hex').slice(0, 16)}`;
}

/**
 * A Codex login's `auth.json` as Codex holds it for `home`: the file when Codex
 * stores to files, the OS keyring when it does not. Undefined when there is
 * none. The keyring is read with the platform's own tool, because the value is
 * Codex's and patch holds no copy of its own.
 */
export function readCodexAuth(
  home: string,
  run: (cmd: string, args: string[]) => string = (cmd, args) =>
    execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }),
): string | undefined {
  const file = join(home, 'auth.json');
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const user = codexKeyringUser(home);
  try {
    const out =
      process.platform === 'darwin'
        ? run('security', ['find-generic-password', '-s', 'Codex Auth', '-a', user, '-w'])
        : run('secret-tool', ['lookup', 'service', 'Codex Auth', 'username', user]);
    return out.trim() === '' ? undefined : out.trim();
  } catch {
    return undefined;
  }
}

/** Write a Codex login where a file-store Codex reads it. */
export function writeCodexAuth(home: string, authJson: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'auth.json');
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, authJson, { mode: 0o600 });
  renameSync(tmp, file);
}
