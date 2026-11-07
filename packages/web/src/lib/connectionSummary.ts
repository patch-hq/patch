import type { ConnectionState, HostPresence } from '../stores/presenceStore.js';
import { hostLabel, sortHosts } from '../routes/settings/hostScope.js';

const SERVER_STATE: Record<ConnectionState, string> = {
  connecting: 'connecting',
  connected: 'connected',
  reconnecting: 'reconnecting',
  offline: 'offline',
};

/** Hosts that have connected before and are offline now. A host that has never connected is not "down". */
export function hostsDown(hosts: Record<string, HostPresence>): HostPresence[] {
  return sortHosts(Object.values(hosts).filter((h) => !h.online && h.lastSeenAt !== null));
}

function lastSeen(h: HostPresence): string {
  if (h.online || h.lastSeenAt === null) return '';
  const d = new Date(h.lastSeenAt);
  const hhmm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const today = d.toDateString() === new Date().toDateString();
  const when = today
    ? hhmm
    : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${hhmm}`;
  return `, last seen ${when}`;
}

/**
 * The text behind the brand dot: every party in the surfaces ↔ server ↔ hosts
 * chain, one line each. This surface's link to the server is the only thing a
 * surface can observe about the server, so that line speaks for both.
 */
export function connectionSummary(
  connection: ConnectionState,
  hosts: Record<string, HostPresence>,
): string {
  const list = sortHosts(Object.values(hosts));
  return [
    `This surface (web): ${SERVER_STATE[connection]}`,
    `Server: ${connection === 'connected' ? 'reachable' : SERVER_STATE[connection]}`,
    ...(list.length === 0
      ? ['Hosts: none registered']
      : list.map((h) => `Host ${hostLabel(h)}: ${h.online ? 'online' : 'offline'}${lastSeen(h)}`)),
  ].join('\n');
}
