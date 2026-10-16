import { copyFileSync, existsSync, statSync, truncateSync } from 'node:fs';

export const DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Cap a log the service manager appends to (launchd / systemd hold it open, so
 * it cannot be renamed away): the current contents are copied to `<path>.1`,
 * replacing the previous copy, and the file is truncated in place. Returns
 * whether it rotated.
 */
export function rotateLog(path: string, maxBytes = DAEMON_LOG_MAX_BYTES): boolean {
  if (!existsSync(path) || statSync(path).size <= maxBytes) return false;
  copyFileSync(path, `${path}.1`);
  truncateSync(path, 0);
  return true;
}
