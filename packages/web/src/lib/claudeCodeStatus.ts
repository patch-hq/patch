// Whether Claude Code is on the online hosts. "Connected" only says an account
// is signed in; a chat also needs the Claude Code program on the host, and the
// host installs it by itself. This reads where that stands.

import { CLAUDE_BACKEND_ID } from '@patch/wire';
import { usePresenceStore, type HostPresence } from '../stores/presenceStore.js';

export interface ClaudeCodeHost {
  host: HostPresence;
  state: string;
  error: string | undefined;
}

/** Every online host's Claude Code state, as the host last reported it. */
export function useClaudeCodeHosts(): ClaudeCodeHost[] {
  const hosts = usePresenceStore((s) => s.hosts);
  return Object.values(hosts)
    .filter((h) => h.online && h.host)
    .flatMap((h) => {
      const b = h.host?.backends.find((x) => x.id === CLAUDE_BACKEND_ID);
      return b ? [{ host: h, state: b.state, error: b.error }] : [];
    });
}

/** True when no online host can run Claude Code right now. */
export function useClaudeCodeMissing(): boolean {
  const hosts = useClaudeCodeHosts();
  return (
    hosts.length > 0 &&
    hosts.every((h) => h.state === 'absent' || h.state === 'failed' || h.state === 'installing')
  );
}
