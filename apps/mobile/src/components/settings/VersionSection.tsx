// Settings → Updates (spec/11 § Mobile OTA, § Version reporting). Says whether
// Patch is up to date, with one action when it is not, a manual check and when it
// last ran. Versions and per-layer detail are deliberately not shown. The
// Settings list puts a pip on Updates whenever something is behind
// (useUpdatesBehind).
//
// Three cases look alike from the OTA's own point of view and have to be told
// apart: an update downloaded but not yet launched (`checkForUpdateAsync` then
// reports nothing further, so the page must say "restart", not "up to date");
// a launch not yet checking the paired server (updateSource.ts); and a phone on
// an older native runtime, for which the server correctly offers nothing over
// the air. The published APK's runtime is what tells the last one apart from
// genuinely current: that build is INSTALLED in place, from here.

import React from 'react';
import { Alert } from 'react-native';
import * as Updates from 'expo-updates';
import { useUpdates } from 'expo-updates';
import type { VersionReport } from '@patch/wire';
import { api } from '../../api/rest';
import { getLastCheckedAt, runUpdateCheck, type UpdateCheckResult } from '../../lib/updateCheck';
import { installApk, useApkInstallStore } from '../../lib/apkInstall';
import { refreshPublishedApk, usePublishedApkStore } from '../../lib/publishedApk';
import { updateSourceProblem } from '../../lib/updateSource';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore';
import { SettingsSection } from '../SettingsSection';
import { sendToHost } from './hostSend';
import { sortedHosts } from './HostSwitcher';
import { SettingsPage } from './SettingsPage';
import { ErrorLine, Row, RowValue, SettingsButton, ToggleRow, ValueRow, WithSettings } from './ui';
import { patchShared } from './sharedWrite';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short absolute timestamp, e.g. "31 Jul 2026, 14:07". Manual (not toLocale*,
 *  which is unreliable under Hermes) so it renders identically on every device. */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unavailable';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

function hostStatus(h: HostPresence): string {
  if (!h.online) return 'Offline';
  if (h.host?.updateHeld) return 'Update waiting for chats to finish';
  if (h.host?.updatePending) return 'Update on its way';
  return h.host?.updateAvailable ? 'Update available' : 'Up to date';
}

export function UpdatesPage(): React.ReactElement {
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

  const behindHosts = sortedHosts(hosts).filter((h) => h.host?.updateAvailable === true);
  const heldHosts = behindHosts.filter((h) => h.host?.updateHeld === true);
  // A held host updates itself once its chats finish; pressing Update would only defer again.
  const onlineBehind = behindHosts.filter((h) => h.online && h.host?.updateHeld !== true);
  const onlyWaiting = behindHosts.length > 0 && heldHosts.length === behindHosts.length;
  // The agent lagging the server is the same fact a host row already states.
  const drift = (report?.drift ?? []).filter(
    (d) => !(d.kind === 'daemon-server-mismatch' && behindHosts.length > 0),
  );
  const anyBehind = pending || apkAvailable || behindHosts.length > 0 || drift.length > 0;

  let sentence: string;
  if (busy) sentence = isDownloading ? 'Downloading update…' : 'Checking for updates…';
  else if (install.phase === 'downloading')
    sentence = `Downloading update${install.fraction !== null ? ` · ${Math.round(install.fraction * 100)}%` : ''}`;
  else if (install.phase === 'installing') sentence = 'Installing update…';
  else if (pending) sentence = 'Update ready';
  else if (apkAvailable) sentence = 'Update available';
  else if (sourceProblem) sentence = sourceProblem;
  else if (failure) sentence = `Couldn't check for updates: ${failure}`;
  else if (reportError) sentence = `Couldn't check for updates: ${reportError}`;
  else if (onlyWaiting && !pending && !apkAvailable && drift.length === 0)
    sentence = 'Updating when your chats are idle';
  else if (anyBehind) sentence = 'Update available';
  else if (!report) sentence = 'Checking for updates…';
  else sentence = 'Up to date';

  // One action for the one thing that matters most; the rest follows on its own.
  let action: React.ReactElement | null = null;
  if (pending) {
    action = (
      <SettingsButton
        testID="restart-to-update"
        label="Restart to update"
        onPress={() => void Updates.reloadAsync()}
      />
    );
  } else if (apkAvailable && apk) {
    action = (
      <SettingsButton
        testID="install-apk"
        label={installing ? 'Installing…' : 'Update'}
        disabled={installing}
        onPress={() => void installApk(apk.url, apk.version)}
      />
    );
  } else if (onlineBehind.length > 0) {
    action = (
      <SettingsButton
        testID="update-all"
        label="Update"
        onPress={() =>
          onlineBehind.forEach(
            (h) => void sendToHost(h.hostId, { type: 'host.update', hostId: h.hostId }, 'Update'),
          )
        }
      />
    );
  }

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
      <SettingsSection testID="updates-status">
        <Row title={sentence} titleTestID="update-status" right={action} />
        {reportError ? (
          <ErrorLine testID="version-error" message={reportError} onRetry={readReport} />
        ) : null}
      </SettingsSection>

      {sortedHosts(hosts).length > 0 ? (
        <SettingsSection testID="version-hosts" title="Hosts">
          {sortedHosts(hosts).map((h) => (
            <Row
              key={h.hostId}
              title={h.host?.hostName ?? h.hostId}
              subtitle={hostStatus(h)}
              testID={`version-host-${h.hostId}`}
              right={
                h.host?.updateHeld && h.online ? (
                  <SettingsButton
                    testID={`update-now-${h.hostId}`}
                    label="Update now"
                    onPress={() =>
                      Alert.alert(
                        `Update ${h.host?.hostName ?? h.hostId} now?`,
                        'Chats running on it will be stopped mid-turn.',
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Update now',
                            style: 'destructive',
                            onPress: () =>
                              void sendToHost(
                                h.hostId,
                                { type: 'host.update', hostId: h.hostId, force: true },
                                'Update',
                              ),
                          },
                        ],
                      )
                    }
                  />
                ) : h.host ? (
                  <RowValue>{h.host.hostVersion}</RowValue>
                ) : null
              }
            />
          ))}
        </SettingsSection>
      ) : null}

      <WithSettings testID="update-mode">
        {(data) => (
          <SettingsSection testID="updates-mode">
            <ToggleRow
              label="Update automatically"
              testID="auto-update"
              value={data.preferences.autoUpdateHosts}
              onChange={(next) => void patchShared('Auto-update', { autoUpdateHosts: next })}
            />
          </SettingsSection>
        )}
      </WithSettings>

      <SettingsSection testID="updates-last-checked">
        <ValueRow
          label="Last checked"
          value={lastChecked ? formatWhen(lastChecked) : 'Never'}
          testID="update-last-checked"
        />
      </SettingsSection>
    </SettingsPage>
  );
}
