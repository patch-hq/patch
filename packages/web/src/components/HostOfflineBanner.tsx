// HostOfflineBanner — app-level banner (rendered once, in AppShell) shown
// when the server WS is up but every host is offline. Per spec/14 ##
// Offline / error states: "Host offline — messages queued." It is
// app-level rather than per-chat so it shows on Jobs/Settings/New chat too,
// not only inside an open chat (spec/12 § Host-offline UX).

import { useEffect, useState, type JSX } from 'react';
import { describeHostOffline } from '@patch/wire';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { getDesktopBridge } from '../lib/desktopBridge.js';

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
  const offlineReason = usePresenceStore((s) =>
    hostId === undefined ? undefined : (s.hosts[hostId]?.offlineReason ?? undefined),
  );
  const offlineAt = usePresenceStore((s) =>
    hostId === undefined ? null : (s.hosts[hostId]?.offlineAt ?? null),
  );
  // Re-render so a busy host turns into "offline" once it has been gone long enough.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (offlineAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [offlineAt]);
  const updatingTo = usePresenceStore((s) =>
    hostId === undefined ? undefined : s.hostsUpdating[hostId],
  );
  const autoUpdate = usePreferencesStore((s) => s.preferences.autoUpdateHosts);
  const updating = autoUpdate && updatingTo !== undefined;
  const setDiagnosticsOpen = useUiStore((s) => s.setDiagnosticsOpen);
  const hostsSeeded = usePresenceStore((s) => s.hostsSeeded);
  const restart = useRestartLocalHost(hostId);
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
          ? `${hostName} is being updated to ${updatingTo}. Messages to this chat are queued and sent when it is back.`
          : hostId === undefined
            ? 'No host is online. Messages are queued and sent when one reconnects. If the host runs on this computer, restart it.'
            : `${describeHostOffline(hostName, offlineReason, offlineAt === null ? undefined : now - offlineAt)}. Messages to this chat are queued and sent when it reconnects.`}
      </span>
      {/* Diagnose, not a dead end: opens the diagnostics screen as a dismissible
          overlay (spec/12 § Connection diagnostics screen). The app stays
          navigable — a daemon-offline surface is never blocked. */}
      {updating || restart === null ? null : (
        <button
          type="button"
          className="banner-diagnose"
          data-testid="daemon-offline-restart"
          disabled={restart.busy}
          onClick={restart.run}
        >
          {restart.busy ? 'Restarting…' : 'Restart host'}
        </button>
      )}
      {restart?.error ? (
        <span data-testid="daemon-offline-restart-error">{restart.error}</span>
      ) : null}
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

/**
 * Restart host, offered only where it can work: in the desktop app, for the host
 * that runs on this computer (a scoped banner on another computer's host has no
 * process here to restart). Null when it is not offered.
 */
function useRestartLocalHost(
  hostId: string | undefined,
): { busy: boolean; error: string | null; run: () => void } | null {
  const bridge = getDesktopBridge()?.localHost;
  const [local, setLocal] = useState<{ installed: boolean; hostId: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (bridge === undefined) return;
    bridge.status().then(setLocal, () => setLocal(null));
  }, [bridge]);
  if (bridge === undefined || local === null || !local.installed) return null;
  if (hostId !== undefined && local.hostId !== hostId) return null;
  return {
    busy,
    error,
    run: () => {
      setBusy(true);
      setError(null);
      bridge.restart().then(
        () => setBusy(false),
        (e: unknown) => {
          setBusy(false);
          setError(`The host did not restart: ${e instanceof Error ? e.message : String(e)}`);
        },
      );
    },
  };
}
