// HostOfflineBanner — app-level banner (rendered once, in AppShell) shown
// when the server WS is up but every host is offline. Per spec/14 ##
// Offline / error states: "Host offline — messages queued." It is
// app-level rather than per-chat so it shows on Jobs/Settings/New chat too,
// not only inside an open chat (spec/12 § Host-offline UX).

import type { JSX } from 'react';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';

// With `hostId` the banner is scoped to that one host (a chat on it): it
// shows whenever THAT host is down, even while another is up, and names it.
// Without, it is the app-level banner for every host being offline.
export function HostOfflineBanner({ hostId }: { hostId?: string } = {}): JSX.Element | null {
  const connection = usePresenceStore((s) => s.connection);
  const hostOnline = usePresenceStore((s) =>
    hostId === undefined ? s.hostOnline : (s.hosts[hostId]?.online ?? true),
  );
  const anyOnline = usePresenceStore((s) => s.hostOnline);
  const hostName = usePresenceStore((s) =>
    hostId === undefined
      ? ''
      : (s.hosts[hostId]?.host?.hostName ?? s.hosts[hostId]?.registeredName ?? hostId).trim(),
  );
  // The host said it is restarting to install an update: a known gap, not a mystery.
  const updating = usePresenceStore((s) =>
    hostId === undefined
      ? Object.values(s.hosts).some((h) => !h.online && h.offlineReason === 'updating')
      : s.hosts[hostId]?.offlineReason === 'updating',
  );
  // Which host is restarting, by name, for the app-level banner.
  const restartingName = usePresenceStore((s) => {
    const h = Object.entries(s.hosts).find(([, v]) => !v.online && v.offlineReason === 'updating');
    return h === undefined ? '' : (h[1].host?.hostName ?? h[1].registeredName ?? h[0]).trim();
  });
  const setDiagnosticsOpen = useUiStore((s) => s.setDiagnosticsOpen);
  const hostsSeeded = usePresenceStore((s) => s.hostsSeeded);
  // Until the auth.ok greeting seeds the roster, hostOnline is unknown, not false.
  if (connection !== 'connected' || !hostsSeeded) return null;
  if (hostOnline) return null;
  // Every host down is the app-level banner's job; a second one here would double it.
  if (hostId !== undefined && !anyOnline) return null;
  return (
    <div className="daemon-offline-banner" data-testid="daemon-offline-banner" role="status">
      <span className="dot" aria-hidden />
      <span>
        {updating
          ? hostId === undefined
            ? `${restartingName || 'A machine'} is installing an update. Messages are queued and sent when it is back.`
            : `${hostName} is installing an update. Messages to this chat are queued and sent when it is back.`
          : hostId === undefined
            ? 'Agent offline. Messages are queued and sent when it reconnects.'
            : `${hostName} is offline. Messages to this chat are queued and sent when it reconnects.`}
      </span>
      {/* Diagnose, not a dead end: opens the diagnostics screen as a dismissible
          overlay (spec/12 § Connection diagnostics screen). The app stays
          navigable — a daemon-offline surface is never blocked. */}
      {updating ? null : (
        <button
          type="button"
          className="banner-diagnose"
          data-testid="daemon-offline-diagnose"
          onClick={() => setDiagnosticsOpen(true)}
        >
          Diagnose
        </button>
      )}
    </div>
  );
}
