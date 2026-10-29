// hostStatus — one way to name a host and say what state it is in.
//
// A host being offline is a normal state, not a fault: a laptop host sleeps,
// travels and restarts to update. So it is said calmly, by name, and only
// where it matters — on the chats, files and settings that need THAT host —
// rather than as an app-wide error. Everything that names a down host reads
// it from here, so the wording is the same in every place.

import { agoLabel } from '../routes/settings/hostWrite.js';
import { usePresenceStore, type HostPresence } from '../stores/presenceStore.js';

/** "Mac host" — the machine's name with "host" so it is clear what it is. */
export function hostTitle(h: HostPresence | undefined, hostId: string): string {
  const name = (h?.host?.hostName ?? h?.registeredName ?? hostId).trim() || hostId;
  return `${name} host`;
}

export type HostState = 'online' | 'updating' | 'offline';

export function hostState(h: HostPresence | undefined): HostState {
  // Unknown (not in the roster yet) reads as online: nothing to warn about.
  if (h === undefined || h.online) return 'online';
  return h.offlineReason === 'updating' ? 'updating' : 'offline';
}

/** "Mac host offline" / "Mac host updating" */
export function hostStateSentence(h: HostPresence | undefined, hostId: string): string {
  const title = hostTitle(h, hostId);
  return hostState(h) === 'updating' ? `${title} updating` : `${title} offline`;
}

/** "2h ago" since it was last seen, or null when never seen or updating. */
export function hostLastSeen(h: HostPresence | undefined): string | null {
  if (h === undefined || h.online || h.offlineReason === 'updating' || h.lastSeenAt === null) {
    return null;
  }
  return agoLabel(h.lastSeenAt);
}

export interface HostStatusView {
  hostId: string;
  state: HostState;
  title: string;
  /** Empty while online. */
  sentence: string;
  /** "2h ago", or null. */
  lastSeen: string | null;
}

export function hostStatusView(h: HostPresence | undefined, hostId: string): HostStatusView {
  const state = hostState(h);
  return {
    hostId,
    state,
    title: hostTitle(h, hostId),
    sentence: state === 'online' ? '' : hostStateSentence(h, hostId),
    lastSeen: hostLastSeen(h),
  };
}

/** "Mac host offline · last seen 2h ago" */
export function hostStatusLine(v: HostStatusView): string {
  return v.lastSeen === null ? v.sentence : `${v.sentence} · last seen ${v.lastSeen}`;
}

/**
 * For a place that was TOLD the host is offline (a request came back
 * host_offline) even if presence has not caught up: never an empty line.
 */
export function hostDownLine(v: HostStatusView): string {
  return v.state === 'online' ? `${v.title} offline` : hostStatusLine(v);
}

/** One host's status, live. `hostId` null/undefined reads as online. */
export function useHostStatus(hostId: string | null | undefined): HostStatusView {
  const h = usePresenceStore((s) => (hostId ? s.hosts[hostId] : undefined));
  // Only trust "offline" once the greeting has seeded the roster.
  const seeded = usePresenceStore((s) => s.hostsSeeded && s.connection === 'connected');
  if (!hostId) return { hostId: '', state: 'online', title: 'Host', sentence: '', lastSeen: null };
  return hostStatusView(seeded ? h : undefined, hostId);
}
