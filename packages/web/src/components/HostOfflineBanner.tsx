// HostOfflineBanner — says a host is down, by name, where it matters.
//
// A host going offline is expected (a laptop sleeps, travels, restarts to
// update), so this is a calm grey strip, not an alarm, and it is scoped:
//   - with `hostId` (inside a chat): that chat's host is down while another
//     host is up — only this chat waits, so only this chat says so;
//   - without (AppShell, once): EVERY host is down, so nothing can run
//     anywhere — the one case that belongs to the whole app. It keeps
//     Diagnose, since "everything is unreachable" can be a real fault.
// Messages still queue in both cases and are sent when the host is back
// (spec/12 § Host-offline UX).

import type { JSX } from 'react';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { hostStatusLine, hostStatusView, useHostStatus } from '../lib/hostStatus.js';
import { sortHosts } from '../routes/settings/hostScope.js';

export function HostOfflineBanner({ hostId }: { hostId?: string } = {}): JSX.Element | null {
  return hostId === undefined ? <AllHostsOfflineBanner /> : <ChatHostBanner hostId={hostId} />;
}

function ChatHostBanner({ hostId }: { hostId: string }): JSX.Element | null {
  const status = useHostStatus(hostId);
  const anyOnline = usePresenceStore((s) => s.hostOnline);
  if (status.state === 'online') return null;
  // Every host down is the app-level banner's job; a second one here would double it.
  if (!anyOnline) return null;
  return (
    <div
      className="daemon-offline-banner"
      data-testid="daemon-offline-banner"
      data-state={status.state}
      role="status"
    >
      <span className="dot" aria-hidden />
      <span>
        {hostStatusLine(status)} Messages to this chat are queued and sent when it is back.
      </span>
    </div>
  );
}

function AllHostsOfflineBanner(): JSX.Element | null {
  const connection = usePresenceStore((s) => s.connection);
  const hostsSeeded = usePresenceStore((s) => s.hostsSeeded);
  const anyOnline = usePresenceStore((s) => s.hostOnline);
  const hosts = usePresenceStore((s) => s.hosts);
  const setDiagnosticsOpen = useUiStore((s) => s.setDiagnosticsOpen);
  // Until the auth.ok greeting seeds the roster, hostOnline is unknown, not false.
  if (connection !== 'connected' || !hostsSeeded || anyOnline) return null;
  const views = sortHosts(Object.values(hosts)).map((h) => hostStatusView(h, h.hostId));
  const updating = views.length > 0 && views.every((v) => v.state === 'updating');
  const one = views.length === 1 ? views[0]! : null;
  const text =
    one !== null
      ? hostStatusLine(one)
      : views.length === 0
        ? 'No host is set up yet.'
        : `All hosts are offline: ${views.map((v) => v.title.replace(/ host$/, '')).join(', ')}.`;
  return (
    <div
      className="daemon-offline-banner"
      data-testid="daemon-offline-banner"
      data-state={updating ? 'updating' : 'offline'}
      role="status"
    >
      <span className="dot" aria-hidden />
      <span>
        {text}
        {views.length === 0
          ? ''
          : ` Messages are queued and sent when ${one === null ? 'one is' : 'it is'} back.`}
      </span>
      {/* An update is a known gap with nothing to diagnose. Otherwise every
          host unreachable at once can be a real fault, so offer the check. */}
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
