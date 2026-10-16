// Script jobs — the host half (spec/08 § Action — `script`).
//
// A `script` job's fire arrives as `job.exec_request`: run this command, in
// this folder, on this host. There is no chat and no model anywhere in the
// path — that is the point of it, and it is why the host runs the command
// itself rather than routing it through a chat's Bash tool.
//
// NO FALLBACK: a folder that does not exist fails the fire and says so. It is
// never run somewhere else instead — a tick pointed at the wrong directory
// that silently ran in the host's home would report success while doing
// nothing.

import { tailCodePoints } from '@patch/wire';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import type { Logger } from 'pino';
import type { JobExecRequestEvent, WireEvent } from '@patch/wire';
import { SCRIPT_ACTION_OUTPUT_LIMIT } from '@patch/wire/jobs';
import { expandHome } from './expandHome.js';

/**
 * Bytes of each stream held while the command runs. Only the tail is ever
 * reported, so older output is dropped as it arrives rather than buffered —
 * a chatty command must run to completion, not be killed for its volume.
 * Ample slack over `SCRIPT_ACTION_OUTPUT_LIMIT` for trailing whitespace.
 */
const HELD_BYTES = 64 * 1024;

function rollingTail(): { push: (b: Buffer) => void; text: () => string } {
  let held: Buffer[] = [];
  let size = 0;
  return {
    push(b) {
      held.push(b);
      size += b.length;
      if (size > 2 * HELD_BYTES) {
        const all = Buffer.concat(held);
        held = [Buffer.from(all.subarray(all.length - HELD_BYTES))];
        size = HELD_BYTES;
      }
    },
    text: () => Buffer.concat(held).toString('utf8'),
  };
}

/** Keep the TAIL: the interesting part of a failing command is its last words. */
function tail(s: string): string {
  const t = s.trimEnd();
  return t.length <= SCRIPT_ACTION_OUTPUT_LIMIT
    ? t
    : `…${tailCodePoints(t, SCRIPT_ACTION_OUTPUT_LIMIT)}`;
}

export function handleJobExec(
  event: JobExecRequestEvent,
  sender: (e: WireEvent) => void,
  logger: Logger,
): void {
  const started = Date.now();
  const reply = (r: {
    ok: boolean;
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
    error?: string;
  }): void => {
    sender({
      type: 'job.exec_result',
      jobId: event.jobId,
      fireId: event.fireId,
      ok: r.ok,
      exitCode: r.exitCode,
      durationMs: Date.now() - started,
      stdout: tail(r.stdout ?? ''),
      stderr: tail(r.stderr ?? ''),
      ...(r.error !== undefined ? { error: r.error } : {}),
    });
  };

  // Typed the way a shell accepts a path — `~/projects/x` — but this never
  // goes through a shell, so expand it before any fs call.
  const folder = expandHome(event.folder);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    logger.error(
      { jobId: event.jobId, folder: event.folder },
      'job.exec_request: folder not found, refusing to run elsewhere',
    );
    reply({
      ok: false,
      exitCode: null,
      error: `folder not found on this host: ${event.folder}`,
    });
    return;
  }

  // A login shell, then the command in a plain one. Two separate needs.
  //
  // LOGIN, because the command is written by the same person who writes the
  // host's dotfiles, and a tick that works when they type it must work here —
  // the profile's PATH especially.
  //
  // But a non-interactive LOGIN shell reads `~/.bash_logout` whenever `exit` is
  // executed explicitly, and Ubuntu's default one ends in
  //
  //     [ -x /usr/bin/clear_console ] && /usr/bin/clear_console -q
  //
  // which returns 1 for want of a console — a host has none, ever. That
  // becomes the shell's exit status, so `set -euo pipefail` + `exit 0`, i.e. how
  // every careful gate is written, reported FAILURE on every correct hold
  // (caught 12 Sep 2026 the first time a gate printed a verdict and the run
  // still came back `dispatch-error`). `exec` is the fix: it replaces the login
  // shell with a plain one, so there is no login shell left to read a logout
  // file, and the status recorded is the command's own and nothing else.
  //
  // The command travels in the ENVIRONMENT rather than inside the `-c` string so
  // there is no quoting to get wrong — a gate is full of quotes and heredocs.
  const child = spawn('/bin/bash', ['-lc', 'exec /bin/bash -c "$PATCH_JOB_COMMAND"'], {
    cwd: folder,
    env: { ...process.env, PATCH_JOB_COMMAND: event.command },
    timeout: event.timeoutMs,
    killSignal: 'SIGKILL',
  });
  const stdout = rollingTail();
  const stderr = rollingTail();
  child.stdout.on('data', stdout.push);
  child.stderr.on('data', stderr.push);
  let settled = false;
  const fail = (exitCode: number | null, error: string): void => {
    if (settled) return;
    settled = true;
    logger.warn({ jobId: event.jobId, exitCode, err: error }, 'job.exec_request: command failed');
    reply({ ok: false, exitCode, stdout: stdout.text(), stderr: stderr.text(), error });
  };
  child.on('error', (err) => fail(null, `command failed: ${err.message}`));
  child.on('close', (code, signal) => {
    if (code === 0) {
      if (settled) return;
      settled = true;
      reply({ ok: true, exitCode: 0, stdout: stdout.text(), stderr: stderr.text() });
      return;
    }
    fail(
      code,
      child.killed
        ? `command killed after its ${event.timeoutMs}ms timeout`
        : `command failed: ${code !== null ? `exit code ${code}` : `killed by ${signal}`}`,
    );
  });
  // The tick is the host's work, not a reason to keep the process alive.
  child.unref();
}
