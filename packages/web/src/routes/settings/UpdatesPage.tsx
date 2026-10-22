// Settings → Updates: one list of what Patch is running, a version and a status
// for each, and how updates are applied (spec/11 § Version reporting).
//
// Hosts update themselves by default; the toggle turns that off, and then each
// host's Update button (or Update all) is the way. Genuine drift between layers
// the server reports is listed first, with its remedy; otherwise there is
// nothing above the list.
//
// The window runs a UI build of its own, so "This app" states the window's
// build and "Server" the server's, side by side.

import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LayerBuild, VersionReport } from '@patch/wire';
import { api } from '../../api/rest.js';
import { BUILD_INFO } from '../../lib/buildInfo.js';
import { getDesktopBridge, type DesktopUpdaterState } from '../../lib/desktopBridge.js';
import { relativeIso } from '../../lib/relativeTime.js';
import { Toggle } from '../../components/Toggle.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore.js';
import { hostLabel, sortHosts } from './hostScope.js';
import { sendToHost, useHostUpdate } from './hostWrite.js';
import { patchShared } from './sharedWrite.js';
import { Group, Note, Row, SettingsPage } from './ui.js';

/** `0.1.317 · 9b8635f`. */
function stamp(build: Pick<LayerBuild, 'version' | 'gitSha'>): string {
  return build.gitSha ? `${build.version} · ${build.gitSha}` : build.version;
}

/**
 * What the desktop shell's row should say. Driven by the updater's last outcome
 * rather than by comparing versions, so "I couldn't check" never reads as "current".
 *
 * A staged update is REPORTED here and offered by the banner
 * (DesktopUpdateBanner), which is the one place that restarts the app — and only
 * when pressed.
 */
function shellStatus(state: DesktopUpdaterState): string {
  if (state.checking) return 'checking…';
  const result = shellResult(state);
  // Dated, so "up to date" and "check failed" say how stale that answer is.
  return state.lastCheckedAt ? `${result} · checked ${relativeIso(state.lastCheckedAt)}` : result;
}

function shellResult(state: DesktopUpdaterState): string {
  switch (state.lastResult) {
    case 'downloaded':
      return `${state.availableVersion} ready — restart to apply`;
    case 'update-available':
      return `downloading ${state.availableVersion}`;
    case 'up-to-date':
      return 'up to date';
    case 'error':
      return 'check failed';
    default:
      return 'not checked yet';
  }
}

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
  for (const d of report?.drift ?? []) {
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

export function UpdatesPage(): JSX.Element {
  const { data: report, error, isFetching, refetch, dataUpdatedAt } = useVersionReport();
  const { shell, checkShell } = useShell();
  const behind = useBehind();
  const hosts = usePresenceStore((s) => s.hosts);
  const autoUpdate = usePreferencesStore((s) => s.preferences.autoUpdateHosts);
  const loaded = usePreferencesStore((s) => s.loaded);
  const drift = behind.filter((b) => b.kind === 'drift');
  const updatable = behind.flatMap((b) => (b.kind === 'host' && b.host.online ? [b.host] : []));
  // The host build the behind hosts would update TO: the published channel's
  // version. Only read while something is behind; unread, the row states just
  // the version the host runs rather than guessing a target.
  const hostsBehind = behind.some((b) => b.kind === 'host');
  const { data: published } = useQuery({
    queryKey: ['host-manifest'],
    queryFn: () => api.hostManifest(),
    enabled: hostsBehind,
    retry: false,
  });

  const checkAll = (): void => {
    void refetch();
    checkShell();
  };

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
            title={<span data-testid="version-error">Could not read versions</span>}
            sub={(error as Error).message}
          >
            <button type="button" className="set-btn" onClick={() => void refetch()}>
              Retry
            </button>
          </Row>
        </Group>
      ) : null}

      {drift.length > 0 ? (
        <Group label="Behind" testid="version-drift">
          {drift.map((d) => (
            <Row
              key={d.key}
              title={d.detail}
              sub={<code>{d.remedy}</code>}
              testid={`version-drift-${d.driftKind}`}
            />
          ))}
        </Group>
      ) : null}

      <Group>
        <Row title="Update hosts automatically" testid="auto-update">
          <Toggle
            checked={autoUpdate}
            disabled={!loaded}
            onChange={(next) => void patchShared('auto-update', { autoUpdateHosts: next })}
            testid="auto-update-toggle"
          />
        </Row>
        {updatable.length > 0 ? (
          <Row title={`${updatable.length} host${updatable.length === 1 ? '' : 's'} behind`}>
            <button
              type="button"
              className="set-btn"
              data-testid="update-all"
              onClick={() =>
                updatable.forEach((h) => sendToHost(h, { type: 'host.update', hostId: h.hostId }))
              }
            >
              Update all
            </button>
          </Row>
        ) : null}
      </Group>

      <Group label="Components" testid="version-rows">
        <Row
          title="This app"
          testid="version-app"
          sub={
            <>
              <code>{stamp(BUILD_INFO)}</code>
              {report?.web ? ` · deployed ${relativeIso(report.web.deployedAt)}` : ''}
            </>
          }
        />
        {shell ? (
          <Row
            title="Desktop app"
            testid="version-shell"
            sub={
              <>
                <code>{shell.currentVersion}</code> · {shellStatus(shell)}
              </>
            }
          />
        ) : null}
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
        {report ? (
          <Row
            title="Server"
            testid="version-detail-server"
            sub={
              <>
                <code>{stamp(report.server)}</code> · up {relativeIso(report.server.startedAt)}
              </>
            }
          />
        ) : null}
        {sortHosts(Object.values(hosts)).map((h) => {
          const behindNow = h.host?.updateAvailable === true;
          const target = behindNow && published?.version ? ` → ${published.version}` : '';
          return (
            <Row
              key={h.hostId}
              title={`${hostLabel(h)} host`}
              testid={`version-host-${h.hostId}`}
              sub={
                h.host ? (
                  <>
                    <code>{`${h.host.hostVersion}${target}`}</code>
                    {` · ${behindNow ? 'behind' : 'up to date'}${h.online ? '' : ' · offline'}`}
                  </>
                ) : (
                  'not reported'
                )
              }
            >
              {behindNow ? <HostUpdateButton host={h} /> : null}
            </Row>
          );
        })}
        {report?.desktop ? (
          <Row
            title="Desktop on the update feed"
            testid="version-detail-feed"
            sub={
              <>
                <code>{stamp(report.desktop)}</code> · published{' '}
                {relativeIso(report.desktop.publishedAt)}
              </>
            }
          />
        ) : null}
        {report?.android ? (
          <Row
            title="Android APK"
            testid="version-detail-android"
            sub={
              <>
                <code>{stamp(report.android)}</code> · published{' '}
                {relativeIso(report.android.publishedAt)}
              </>
            }
          />
        ) : null}
        {!report && !error ? <Note>Loading…</Note> : null}
      </Group>

      <Group>
        <Row title="Last checked" testid="version-checked">
          <span className="set-val">
            {report ? relativeIso(new Date(dataUpdatedAt).toISOString()) : '—'}
          </span>
        </Row>
      </Group>
    </SettingsPage>
  );
}

/** Split out from the `behind` list's `.map` — `useHostUpdate` is a hook, and the
 * list's length varies with what is behind. */
function HostUpdateButton({ host }: { host: HostPresence }): JSX.Element {
  const { updating, apply } = useHostUpdate(host);
  return (
    <button
      type="button"
      className="set-btn"
      disabled={updating}
      data-testid={`host-${host.hostId}-update`}
      onClick={apply}
    >
      {updating ? 'Updating…' : 'Update'}
    </button>
  );
}
