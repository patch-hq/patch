// Settings → Updates: whether Patch is up to date, and one Update button when it
// is not. Each host is listed with its plain version (no shas, no layers, no
// developer commands — spec/11 § Version reporting). A host that is behind only
// because its chats are mid-turn says so: it updates itself once they finish.
//
// Hosts update themselves by default; the toggle turns that off, and then Update
// is the way. The desktop shell's staged update is restarted from the banner
// (DesktopUpdateBanner), never from here.

import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { VersionReport } from '@patch/wire';
import { api } from '../../api/rest.js';
import { getDesktopBridge, type DesktopUpdaterState } from '../../lib/desktopBridge.js';
import { relativeIso } from '../../lib/relativeTime.js';
import { Toggle } from '../../components/Toggle.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore.js';
import { hostLabel, sortHosts } from './hostScope.js';
import { sendToHost } from './hostWrite.js';
import { patchShared } from './sharedWrite.js';
import { Group, Row, SettingsPage } from './ui.js';

function useVersionReport() {
  return useQuery<VersionReport>({ queryKey: ['version'], queryFn: () => api.version() });
}

/** The desktop shell's updater state, live; null outside the desktop app. */
function useShell(): { shell: DesktopUpdaterState | null; checkShell: () => void } {
  const bridge = getDesktopBridge();
  const [shell, setShell] = useState<DesktopUpdaterState | null>(null);
  // Subscribe to shell updater pushes (download finished, check failed) so the
  // row is live rather than a snapshot taken when Settings mounted.
  useEffect(() => {
    if (!bridge?.getUpdaterState) return;
    void bridge.getUpdaterState().then(setShell);
    return bridge.onUpdaterState?.(setShell);
  }, [bridge]);
  const checkShell = useCallback(() => {
    if (!bridge?.checkForUpdates) return;
    void bridge.checkForUpdates().then(setShell);
  }, [bridge]);
  return { shell, checkShell };
}

export type BehindItem =
  | { kind: 'host'; host: HostPresence }
  | { kind: 'drift'; key: string; driftKind: string; detail: string; remedy: string };

/** Everything that is behind — what the Updates page lists and the nav pip counts. */
export function useBehind(): BehindItem[] {
  const hosts = usePresenceStore((s) => s.hosts);
  const { data: report } = useVersionReport();
  const items: BehindItem[] = sortHosts(Object.values(hosts))
    .filter((h) => h.host?.updateAvailable === true)
    .map((host) => ({ kind: 'host' as const, host }));
  const hostRowsExplain = items.length > 0;
  for (const d of report?.drift ?? []) {
    // The agent lagging the server is the same fact as a host being behind; the
    // host row already says it (and whether it is only waiting on chats).
    if (d.kind === 'daemon-server-mismatch' && hostRowsExplain) continue;
    items.push({
      kind: 'drift',
      key: `${d.kind}-${d.detail}`,
      driftKind: d.kind,
      detail: d.detail,
      remedy: d.remedy,
    });
  }
  return items;
}

function hostStatus(h: HostPresence): string {
  if (!h.online) return 'Offline';
  if (h.host?.updateHeld) return 'Update waiting for chats to finish';
  if (h.host?.updatePending) return 'Update on its way';
  return h.host?.updateAvailable ? 'Update available' : 'Up to date';
}

export function UpdatesPage(): JSX.Element {
  const { data: report, error, isFetching, refetch, dataUpdatedAt } = useVersionReport();
  const { shell, checkShell } = useShell();
  const behind = useBehind();
  const autoUpdate = usePreferencesStore((s) => s.preferences.autoUpdateHosts);
  const loaded = usePreferencesStore((s) => s.loaded);
  const updatable = behind.flatMap((b) =>
    b.kind === 'host' && b.host.online && b.host.host?.updateHeld !== true ? [b.host] : [],
  );
  const shellReady = shell?.lastResult === 'downloaded';
  const shellBusy = shell?.checking === true || shell?.lastResult === 'update-available';
  const upToDate = behind.length === 0 && !shellReady && !shellBusy;
  const hosts = sortHosts(Object.values(usePresenceStore((s) => s.hosts)));
  // Behind only because chats are running: nothing for the user to do.
  const onlyWaiting =
    behind.length > 0 && behind.every((b) => b.kind === 'host' && b.host.host?.updateHeld === true);

  const checkAll = (): void => {
    void refetch();
    checkShell();
  };

  let status = 'Up to date';
  if (error || shell?.lastResult === 'error') status = 'Couldn’t check';
  else if (!report) status = 'Checking…';
  else if (shellReady) status = 'Update ready — restart to apply';
  else if (onlyWaiting) status = 'Updating when your chats are idle';
  else if (!upToDate) status = shellBusy && behind.length === 0 ? 'Checking…' : 'Update available';

  return (
    <SettingsPage
      title="Updates"
      testid="settings-version"
      actions={
        <button
          type="button"
          className="set-btn primary"
          data-testid="version-check-now"
          disabled={isFetching}
          onClick={checkAll}
        >
          {isFetching ? 'Checking…' : 'Check now'}
        </button>
      }
    >
      {error ? (
        <Group>
          <Row
            title={<span data-testid="version-error">Could not check for updates</span>}
            sub={(error as Error).message}
          >
            <button type="button" className="set-btn" onClick={() => void refetch()}>
              Retry
            </button>
          </Row>
        </Group>
      ) : null}

      <Group>
        <Row title={<span data-testid="update-status">{status}</span>} testid="version-status">
          {updatable.length > 0 ? (
            <button
              type="button"
              className="set-btn primary"
              data-testid="update-all"
              onClick={() =>
                updatable.forEach((h) => sendToHost(h, { type: 'host.update', hostId: h.hostId }))
              }
            >
              Update
            </button>
          ) : null}
        </Row>
        {shell?.lastResult === 'error' && shell.lastError ? (
          <Row
            title={
              shell.lastErrorKind === 'install'
                ? 'Last update install failed'
                : 'Last update check failed'
            }
            sub={shell.lastError}
            testid="version-shell-error"
          />
        ) : null}
      </Group>

      {hosts.length > 0 ? (
        <Group label="Hosts" testid="version-hosts">
          {hosts.map((h) => (
            <Row
              key={h.hostId}
              title={hostLabel(h)}
              testid={`version-host-${h.hostId}`}
              sub={h.host ? hostStatus(h) : 'not reported'}
            >
              {h.host?.updateHeld && h.online ? (
                <button
                  type="button"
                  className="set-btn"
                  data-testid={`update-now-${h.hostId}`}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Update ${hostLabel(h)} now? Chats running on it will be stopped mid-turn.`,
                      )
                    ) {
                      sendToHost(h, { type: 'host.update', hostId: h.hostId, force: true });
                    }
                  }}
                >
                  Update now
                </button>
              ) : null}
              {h.host ? <span className="set-val">{h.host.hostVersion}</span> : null}
            </Row>
          ))}
        </Group>
      ) : null}

      <Group>
        <Row title="Update automatically" testid="auto-update">
          <Toggle
            checked={autoUpdate}
            disabled={!loaded}
            onChange={(next) => void patchShared('auto-update', { autoUpdateHosts: next })}
            testid="auto-update-toggle"
          />
        </Row>
        <Row title="Last checked" testid="version-checked">
          <span className="set-val">
            {report ? relativeIso(new Date(dataUpdatedAt).toISOString()) : '—'}
          </span>
        </Row>
      </Group>
    </SettingsPage>
  );
}
