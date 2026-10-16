import { basename, join, dirname } from 'node:path';
import { lstatSync, symlinkSync, unlinkSync } from 'node:fs';

/**
 * Host rename: a CLI or MCP child built before it still looks for
 * `daemon.sock`. When the host listens on the default `host.sock`, leave a
 * `daemon.sock` symlink beside it so those keep reaching it. Removed with the
 * old name once every host has updated.
 */
export function linkLegacySocket(socketPath: string): void {
  if (basename(socketPath) !== 'host.sock') return;
  const legacy = join(dirname(socketPath), 'daemon.sock');
  let st;
  try {
    st = lstatSync(legacy);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (st) {
    // A previous (pre-rename) run leaves a socket; a previous run of this one a symlink.
    if (!st.isSocket() && !st.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-socket file at ${legacy}; resolve manually.`);
    }
    unlinkSync(legacy);
  }
  symlinkSync(socketPath, legacy);
}
