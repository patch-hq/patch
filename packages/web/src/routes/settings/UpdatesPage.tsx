// Settings → Updates: one account-wide switch over every part of Patch
// (spec/11 § One update switch). On: the server and hosts move to each new release
// together in the background, and the window offers one Restart (UpdateBanner).
// Off: nothing moves until "Update everything", which updates the server, then
// every host. The user never manages parts one by one.

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
import { sortHosts } from './hostScope.js';
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

function isNewer(candidate: string, running: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(candidate);
  const b = parse(running);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export const AUTO_ON_HINT =
  'Controls when hosts and server move to a new version. Updates are synchronised between all components.';
export const DEV_CHANNEL_WARNING =
  'Development builds are unstable and can break things. You get every build as soon as it is made, not just tagged releases.';
export const UPDATE_ALL_HINT = 'Chats run in their own processes and keep running.';

export function UpdatesPage(): JSX.Element {
  const { data: report, error, isFetching, refetch } = useVersionReport();
  const { checkShell } = useShell();
  const behind = useBehind();
  const autoUpdate = usePreferencesStore((s) => s.preferences.autoUpdateHosts);
  const loaded = usePreferencesStore((s) => s.loaded);
  const [requested, setRequested] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);

  const running = report?.server.version ?? null;
  const available = report?.release?.available ?? null;
  const newer = running !== null && available !== null && isNewer(available, running);
  const hostsBehind = behind.some((b) => b.kind === 'host');
  const updating = report?.release?.updating === true || requested;

  // Poll while an update runs, so the page follows it to the end.
  useEffect(() => {
    if (!updating) return;
    const id = window.setInterval(() => void refetch(), 10_000);
    return () => window.clearInterval(id);
  }, [updating, refetch]);
  useEffect(() => {
    if (requested && report?.release?.updating === false && !newer && !hostsBehind) {
      setRequested(false);
    }
  }, [requested, report, newer, hostsBehind]);

  const checkAll = (): void => {
    void refetch();
    checkShell();
  };

  const updateEverything = (): void => {
    setRequestError(null);
    setRequested(true);
    api.updateAll().then(
      () => void refetch(),
      (err: unknown) => {
        setRequested(false);
        setRequestError(err instanceof Error ? err.message : String(err));
      },
    );
  };

  const channel = report?.release?.channel ?? null;
  const setDev = (next: boolean): void => {
    setChannelError(null);
    api.setReleaseChannel(next ? 'dev' : 'stable').then(
      () => void refetch(),
      (err: unknown) => setChannelError(err instanceof Error ? err.message : String(err)),
    );
  };

  let status = 'Up to date';
  if (!report) status = 'Checking…';
  else if (updating || newer || hostsBehind) status = 'Updating…';

  return (
    <SettingsPage
      title="Updates"
      testid="settings-version"
      actions={
        <button
          type="button"
          className="set-btn"
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
        <Row
          title="Update automatically"
          sub={autoUpdate ? AUTO_ON_HINT : undefined}
          testid="auto-update"
        >
          <Toggle
            checked={autoUpdate}
            disabled={!loaded}
            onChange={(next) => void patchShared('auto-update', { autoUpdateHosts: next })}
            testid="auto-update-toggle"
          />
        </Row>
      </Group>

      {channel !== null && channel !== 'off' ? (
        <Group>
          <Row
            title="Include development builds"
            sub={
              channelError ??
              (channel === 'dev' ? DEV_CHANNEL_WARNING : 'Off: tagged stable releases only.')
            }
            testid="release-channel"
          >
            <Toggle checked={channel === 'dev'} onChange={setDev} testid="release-channel-toggle" />
          </Row>
        </Group>
      ) : null}

      <Group testid="version-layers">
        <Row title="Version" testid="version-server">
          <span className="set-val">{running ?? '—'}</span>
        </Row>
        {autoUpdate ? (
          <>
            <Row title="Status" testid="version-status">
              <span className="set-val" data-testid="update-status">
                {status}
              </span>
            </Row>
            <Row title="Last updated" testid="version-last-updated">
              <span className="set-val">{report ? relativeIso(report.server.startedAt) : '—'}</span>
            </Row>
          </>
        ) : (
          <>
            {newer ? (
              <Row title="Available" testid="version-available">
                <span className="set-val set-val-available">{available}</span>
              </Row>
            ) : null}
            {newer || hostsBehind || updating ? (
              <Row
                title={
                  <button
                    type="button"
                    className="set-btn primary"
                    data-testid="update-all"
                    disabled={updating}
                    onClick={updateEverything}
                  >
                    {updating ? 'Updating…' : 'Update everything'}
                  </button>
                }
                sub={requestError ?? UPDATE_ALL_HINT}
                testid="update-all-row"
              />
            ) : (
              <Row title="Status" testid="version-status">
                <span className="set-val" data-testid="update-status">
                  {status}
                </span>
              </Row>
            )}
          </>
        )}
      </Group>
    </SettingsPage>
  );
}
