// Settings → Updates (design/settings-redesign; spec/11 § Mobile OTA, § Version
// reporting; project rule: every app surfaces its current version, the running
// build, the last check date, and a manual check).
//
// Check now at the top; Behind — each thing that is behind, with the action
// that fixes it (Restart to update, Download APK, a host's Update, and any
// drift between layers with its remedy); Versions — every layer; and when the
// last check ran, with what it found. The Settings list puts a pip on Updates
// whenever something is behind (useUpdatesBehind).
//
// Three cases look alike from the OTA's own point of view and have to be told
// apart: an update downloaded but not yet launched (`checkForUpdateAsync` then
// reports nothing further, so the page must say "restart", not "up to date");
// a launch not yet checking the paired server (updateSource.ts); and a phone on
// an older native runtime, for which the server correctly offers nothing over
// the air. The published APK's runtime is what tells the last one apart from
// genuinely current: that build is INSTALLED in place, from here.

import React from 'react';
import * as Updates from 'expo-updates';
import { useUpdates } from 'expo-updates';
import type { VersionReport } from '@patch/wire';
import { api } from '../../api/rest';
import { mobileBuildInfo } from '../../lib/buildInfo';
import { getLastCheckedAt, runUpdateCheck, type UpdateCheckResult } from '../../lib/updateCheck';
import { installApk, useApkInstallStore } from '../../lib/apkInstall';
import { refreshPublishedApk, usePublishedApkStore } from '../../lib/publishedApk';
import { updateSourceProblem } from '../../lib/updateSource';
import { usePresenceStore } from '../../stores/presenceStore';
import { SettingsSection } from '../SettingsSection';
import { sendToHost } from './hostSend';
import { hostName, sortedHosts } from './HostSwitcher';
import { SettingsPage } from './SettingsPage';
import { ErrorLine, Row, RowValue, SettingsButton, ValueRow } from './ui';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short absolute timestamp, e.g. "31 Jul 2026, 14:07". Manual (not toLocale*,
 *  which is unreliable under Hermes) so it renders identically on every device. */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unavailable';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `0.1.317 · 9b8635f`, or the bare version when the layer carries no sha. */
function stamp(b: { version: string | null; gitSha: string | null }): string {
  const v = b.version ?? 'unknown';
  return b.gitSha ? `${v} · ${b.gitSha}` : v;
}

/**
 * Whether anything is behind — an update downloaded and waiting for a restart,
 * a newer APK than this phone runs, or a host with a host update. Drives the
 * pip on the Settings list's Updates row.
 */
export function useUpdatesBehind(): boolean {
  const { isUpdatePending } = useUpdates();
  const apk = usePublishedApkStore((s) => s.apk);
  const hostBehind = usePresenceStore((s) =>
    Object.values(s.hosts).some((h) => h.host?.updateAvailable === true),
  );
  return isUpdatePending || (apk?.needsInstall ?? false) || hostBehind;
}

export function UpdatesPage(): React.ReactElement {
  // What this phone is EXECUTING. version/gitSha/builtAt are inlined into that
  // one bundle together (buildInfo.ts), so they always agree with each other.
  const build = React.useMemo(() => mobileBuildInfo(), []);
  const { isUpdatePending, isChecking, isDownloading, checkError } = useUpdates();
  const [lastChecked, setLastChecked] = React.useState<string | null>(() => getLastCheckedAt());
  const [checking, setChecking] = React.useState(false);
  const [checkedResult, setCheckedResult] = React.useState<UpdateCheckResult | null>(null);
  const apk = usePublishedApkStore((s) => s.apk);
  const install = useApkInstallStore((s) => s.state);
  const hosts = usePresenceStore((s) => s.hosts);
  const [report, setReport] = React.useState<VersionReport | null>(null);
  const [reportError, setReportError] = React.useState<string | null>(null);

  const sourceProblem = updateSourceProblem();

  const readReport = React.useCallback(() => {
    setReportError(null);
    void api
      .version()
      .then(setReport)
      .catch((e: Error) => setReportError(e.message));
  }, []);
  React.useEffect(readReport, [readReport]);

  const check = React.useCallback(async () => {
    setChecking(true);
    setCheckedResult(null);
    const res = await runUpdateCheck();
    setLastChecked(getLastCheckedAt());
    setCheckedResult(res);
    setChecking(false);
    readReport();
    void refreshPublishedApk();
  }, [readReport]);

  const busy = checking || isChecking || isDownloading;
  const pending = isUpdatePending || checkedResult?.status === 'downloaded';
  // Only a build on another runtime: a newer one on this runtime comes over
  // the air. (A relayed phone never reads one — publishedApk.ts.)
  const apkAvailable = !pending && (apk?.needsInstall ?? false);
  const installing = install.phase === 'downloading' || install.phase === 'installing';
  const failure =
    checkedResult?.status === 'error'
      ? checkedResult.message
      : checkError
        ? checkError.message
        : null;

  let sentence: string;
  if (busy) sentence = isDownloading ? 'Downloading update…' : 'Checking for updates…';
  else if (pending) sentence = 'An update is downloaded and ready to install.';
  else if (install.phase === 'downloading')
    sentence = `Downloading Patch ${install.version}${install.fraction !== null ? ` · ${Math.round(install.fraction * 100)}%` : ''}`;
  else if (install.phase === 'installing') sentence = `Installing Patch ${install.version}`;
  else if (apkAvailable) sentence = 'A new build needs installing.';
  else if (sourceProblem) sentence = sourceProblem;
  else if (failure) sentence = `Couldn't check for updates: ${failure}`;
  else if (checkedResult?.status === 'current') sentence = 'Up to date.';
  else sentence = '';

  const behindHosts = sortedHosts(hosts).filter((h) => h.host?.updateAvailable === true);
  const drift = report?.drift ?? [];
  const anyBehind = pending || apkAvailable || behindHosts.length > 0 || drift.length > 0;
  const appStamp = build.gitSha ? `${build.version} · ${build.gitSha}` : build.version;

  return (
    <SettingsPage
      title="Updates"
      testID="settings-version"
      right={
        <SettingsButton
          testID="check-updates"
          label={busy ? 'Checking…' : 'Check now'}
          onPress={() => void check()}
          disabled={busy}
        />
      }
    >
      {anyBehind ? (
        <SettingsSection title="Behind" testID="updates-behind">
          {pending ? (
            <Row
              title="This app"
              subtitle="Downloaded"
              right={
                <SettingsButton
                  testID="restart-to-update"
                  label="Restart to update"
                  variant="quiet"
                  onPress={() => void Updates.reloadAsync()}
                />
              }
            />
          ) : null}
          {apkAvailable && apk ? (
            <Row
              title="This app"
              subtitle={`${build.version} → ${apk.version}`}
              right={
                <SettingsButton
                  testID="install-apk"
                  label={installing ? 'Installing…' : 'Install'}
                  variant="quiet"
                  disabled={installing}
                  onPress={() => void installApk(apk.url, apk.version)}
                />
              }
            />
          ) : null}
          {behindHosts.map((h) => (
            <Row
              key={h.hostId}
              testID={`updates-host-${h.hostId}`}
              title={`${hostName(h)} host`}
              subtitle={h.host?.hostVersion}
              right={
                <SettingsButton
                  testID={`updates-host-${h.hostId}-update`}
                  label="Update"
                  variant="quiet"
                  onPress={() =>
                    void sendToHost(h.hostId, { type: 'host.update', hostId: h.hostId }, 'Update')
                  }
                />
              }
            />
          ))}
          {drift.map((d) => (
            <Row
              key={`${d.kind}-${d.detail}`}
              testID={`version-drift-${d.kind}`}
              title={d.detail}
              subtitle={d.remedy}
            />
          ))}
        </SettingsSection>
      ) : null}

      <SettingsSection title="Versions" testID="updates-versions">
        <ValueRow
          label="This app"
          value={appStamp}
          subtitle={build.builtAt ? `built ${formatWhen(build.builtAt)}` : undefined}
          testID="version-this-app"
        />
        {reportError ? (
          <Row title="Other layers">
            <ErrorLine
              testID="version-error"
              message={`Couldn’t read versions: ${reportError}`}
              onRetry={readReport}
            />
          </Row>
        ) : report ? (
          layerRows(report).map((r) => (
            <ValueRow key={r.id} label={r.name} value={r.value} testID={`version-detail-${r.id}`} />
          ))
        ) : (
          <ValueRow label="Server" value={null} loading testID="version-loading" />
        )}
      </SettingsSection>

      <SettingsSection testID="updates-last-checked">
        <Row
          title="Last checked"
          subtitle={sentence}
          subtitleTestID="update-status"
          right={
            <RowValue testID="update-last-checked">
              {lastChecked ? formatWhen(lastChecked) : 'Never'}
            </RowValue>
          }
        />
      </SettingsSection>
    </SettingsPage>
  );
}

/** Every layer the server reports (`GET /api/version`), as rows. */
function layerRows(report: VersionReport): Array<{ id: string; name: string; value: string }> {
  return [
    ...(report.web ? [{ id: 'web', name: 'Web UI', value: stamp(report.web) }] : []),
    { id: 'server', name: 'Server', value: stamp(report.server) },
    ...report.hosts.map((h) => ({
      id: `host-${h.hostId}`,
      name: `${h.hostName ?? h.hostId} host`,
      value: `${stamp(h)}${h.online ? '' : ' · offline'}`,
    })),
    ...(report.android
      ? [{ id: 'android', name: 'Android APK', value: stamp(report.android) }]
      : []),
    ...report.clients.map((c) => ({
      id: `client-${c.surfaceId}`,
      name: c.surfaceKind,
      value: `${stamp(c)}${c.online ? '' : ' · offline'}`,
    })),
  ];
}
