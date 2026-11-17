import { appendFileSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where a claude process's stderr and its exit go, so a process that ends
 * without saying why still leaves a record. Per chat when the chat has its own
 * `CLAUDE_CONFIG_DIR` (`~/.patch/chats/<id>/claude/claude-stderr.log`),
 * otherwise one shared file under the Patch logs dir.
 */
export const CLAUDE_STDERR_LOG = 'claude-stderr.log';

/** Past this size the log is moved to `<name>.1` (replacing any older one). */
export const CLAUDE_STDERR_MAX_BYTES = 2 * 1024 * 1024;

export function claudeStderrLogPath(env: Record<string, string | undefined>): string {
  const configDir = env['CLAUDE_CONFIG_DIR'];
  if (configDir !== undefined && configDir !== '') return join(configDir, CLAUDE_STDERR_LOG);
  const patchHome = process.env['PATCH_HOME'] ?? join(homedir(), '.patch');
  return join(patchHome, 'logs', CLAUDE_STDERR_LOG);
}

/**
 * Open the log for appending, rotating it first if it has grown past the cap.
 * Returns the fd to hand to `spawn` as stderr; the caller closes its copy once
 * the child has it.
 */
export function openClaudeStderrLog(path: string, maxBytes = CLAUDE_STDERR_MAX_BYTES): number {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return openSync(path, 'a');
}

/** One timestamped line in the log: a spawn, an exit. */
export function noteClaudeProcess(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
}
