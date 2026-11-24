// Provisioning Claude Code on a host that has none (spec/02 § Agent backends,
// case 2: "Absent: install it via the backend's own installer").
//
// The host artifact carries the SDK, never the ~200 MB CLI it drives
// (claudeExecutable.ts). On a computer with nothing installed — no Homebrew, no
// Node — that left every Claude turn failing with the SDK's "Native CLI binary
// not found", and nothing a person could do about it from a surface.
//
// Claude Code's own native installer needs only a shell and curl, both on every
// Mac and every Linux host Patch runs on, and lays the binary down at
// `~/.local/bin/claude` — the first place `resolveClaudeExecutable` looks, and
// the binary `claude update` (claudeCliUpdate.ts) keeps current afterwards.
//
// NO FALLBACK: a failed install is reported with the installer's own output.
// The script is fetched in full before it runs; piped straight into a shell, a
// failed download still exits 0 as an empty script.

import { spawn } from 'node:child_process';

/** Claude Code's published native installer. */
export const CLAUDE_INSTALL_SCRIPT_URL = 'https://claude.ai/install.sh';
/** A ~200 MB download on a slow line is not a failure. */
export const CLAUDE_INSTALL_TIMEOUT_MS = 15 * 60_000;

export interface ClaudeInstallResult {
  ok: boolean;
  exitCode: number | null;
  /** What the installer printed, stdout and stderr interleaved; the tail on failure. */
  output: string;
}

export interface ClaudeInstallOptions {
  home: string;
  /** Injected in tests. */
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
}

export function installClaudeCode(opts: ClaudeInstallOptions): Promise<ClaudeInstallResult> {
  const run = opts.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    const child = run(
      '/bin/sh',
      [
        '-c',
        'script=$(curl -fsSL "$CLAUDE_INSTALL_SCRIPT_URL") && printf "%s\\n" "$script" | bash',
      ],
      {
        env: {
          HOME: opts.home,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          CLAUDE_INSTALL_SCRIPT_URL,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    const keep = (d: Buffer): void => {
      output += d.toString();
      // The installer draws a progress bar; only the end of it matters.
      if (output.length > 64_000) output = output.slice(-32_000);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => {
      output += `\nThe Claude Code installer did not finish within ${Math.round((opts.timeoutMs ?? CLAUDE_INSTALL_TIMEOUT_MS) / 60_000)} minutes.`;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? CLAUDE_INSTALL_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, output: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, exitCode: code, output });
    });
  });
}

/**
 * What a person is told when the install fails. The installer's own output
 * (curl codes, shell errors) goes to the host log, never to a surface.
 * A download that could not start or finish says so and says what to check; any
 * other failure says it plainly without guessing at a cause.
 */
export function installFailure(result: ClaudeInstallResult): string {
  const network =
    result.exitCode === 6 ||
    result.exitCode === 7 ||
    result.exitCode === 28 ||
    result.exitCode === 35 ||
    result.exitCode === 52 ||
    result.exitCode === 56 ||
    /could not resolve host|failed to connect|timed out|connection (reset|refused)|ssl connect/i.test(
      result.output,
    );
  return network
    ? "Couldn't download Claude Code. Check your internet connection."
    : "Claude Code couldn't be installed on this computer.";
}
