// Manual OTA update check + "last checked" persistence for the Settings →
// Version panel (spec/11 § Mobile OTA). The project rule is that every app shows
// its current version, the running build, the last check date, and offers a
// manual check — the mobile app reported its build to the server but never
// surfaced any of it to the user.
//
// Persistence is MMKV (the same store credential/lastUsedSkill use) so the last
// check time survives relaunches. Both the automatic check (otaUpdates.ts) and
// the manual button record through here, so "Last checked" reflects either.
//
// Neither path reloads. This module never did; otaUpdates.ts no longer does
// either (spec/11 § Mobile OTA "NO automatic reload"). The single reload in the
// app is the "Restart to update" button in Settings → Version.

import * as Updates from 'expo-updates';
import { apiUrl } from '../config';
import { mobileBuildInfo } from './buildInfo';
import { store } from './credential';
import { updateSource, updateSourceProblem } from './updateSource';

const LAST_CHECKED_KEY = 'patch.ota.lastCheckedAt';

/** ISO instant of the most recent update check (manual or on-launch), or null. */
export function getLastCheckedAt(): string | null {
  const v = store().getString(LAST_CHECKED_KEY);
  return v !== undefined && v !== '' ? v : null;
}

/** Stamp "now" as the last-checked instant. MMKV writes are synchronous, so the
 *  on-launch checker's stamp is durable the moment it is written. */
export function recordUpdateCheck(nowIso: string): void {
  store().set(LAST_CHECKED_KEY, nowIso);
}

/** The APK the box currently publishes (~/.patch-server/downloads/android-latest.json). */
export interface PublishedApk {
  version: string;
  gitSha: string;
  builtAt: string;
  /** Direct download URL for the APK itself. */
  url: string;
  /** True when the box has published a build more recent than the one this
   *  phone is running — i.e. there is something to install, by whatever path. */
  newer: boolean;
  /** The native runtime the published APK runs; absent from older releases. */
  runtimeVersion?: string;
  /**
   * The published build is newer AND on another runtime, so no update check
   * can bring this phone to it: only installing the APK will. A newer build on
   * this phone's own runtime arrives over the air instead.
   */
  needsInstall: boolean;
}

/**
 * What APK the box publishes, and whether this phone is missing it.
 *
 * This is the question OTA cannot answer BY ITSELF. An OTA only swaps JS under
 * a fixed native build, so when a native change ships — bumping
 * `runtimeVersion` and requiring a new APK — every OTA published after that
 * point is invisible to a phone still on the old native shell: EAS Update only
 * ever serves an update matching the querying device's runtimeVersion, so
 * `checkForUpdateAsync` correctly, and misleadingly, reports "nothing
 * available" forever. (Same story, simpler cause, when the installed APK has
 * no update channel at all and can never receive an OTA.) Comparing the
 * published build against the running one catches both.
 *
 * `newer` is a BUILD-TIME comparison, not a bare commit inequality — the two
 * legitimately disagree in the healthy case too, because an OTA moves the JS
 * ahead of the native shell it launched under, so the running commit is
 * usually AHEAD of the last APK build, not behind it. Only "the published
 * build is more recent than mine" means there is something to install; falls
 * back to a plain sha comparison when this phone's own build time is unknown
 * (an unstamped/dev build).
 *
 * Returns null when the box publishes no APK sidecar. NO FALLBACK: a network or
 * parse failure throws to the caller, which surfaces it rather than reporting
 * "up to date".
 */
export async function fetchPublishedApk(): Promise<PublishedApk | null> {
  const res = await fetch(apiUrl('/api/download/android-latest.json'));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`android-latest.json returned HTTP ${res.status}`);
  const sidecar = (await res.json()) as {
    version: string;
    gitSha: string;
    builtAt: string;
    file: string;
    runtimeVersion?: string;
  };
  const running = mobileBuildInfo();
  const newer = running.builtAt
    ? new Date(sidecar.builtAt).getTime() > new Date(running.builtAt).getTime()
    : sidecar.gitSha !== running.gitSha;
  // A release from before the APK stated its runtime can only be judged by
  // build time, as it always was.
  const otherRuntime =
    sidecar.runtimeVersion === undefined || sidecar.runtimeVersion !== Updates.runtimeVersion;
  return {
    version: sidecar.version,
    gitSha: sidecar.gitSha,
    builtAt: sidecar.builtAt,
    url: apiUrl(`/api/download/${sidecar.file}`),
    newer,
    ...(sidecar.runtimeVersion !== undefined ? { runtimeVersion: sidecar.runtimeVersion } : {}),
    needsInstall: newer && otherRuntime,
  };
}

export type UpdateCheckResult =
  | { status: 'disabled' } // dev / Expo Go — updates are off
  | { status: 'current' } // checked, nothing newer on the channel
  | { status: 'downloaded' } // fetched a new bundle, ready to reload
  | { status: 'error'; message: string };

/**
 * Check the channel for an OTA update and, if one exists, fetch it — but do NOT
 * reload; the caller decides when (a manual check prompts "restart now?"). The
 * check time is recorded regardless of outcome. NO hidden fallback: a failure
 * returns an explicit error the panel shows rather than a silent "up to date".
 */
export async function runUpdateCheck(): Promise<UpdateCheckResult> {
  if (__DEV__ || !Updates.isEnabled) return { status: 'disabled' };
  // Only a launch already pointed at the paired server may check: any other
  // would ask the build-time address, which nothing serves (updateSource.ts).
  const problem = updateSourceProblem(updateSource());
  if (problem !== null) {
    recordUpdateCheck(new Date().toISOString());
    return { status: 'error', message: problem };
  }
  try {
    const res = await Updates.checkForUpdateAsync();
    recordUpdateCheck(new Date().toISOString());
    if (!res.isAvailable) return { status: 'current' };
    await Updates.fetchUpdateAsync();
    return { status: 'downloaded' };
  } catch (err) {
    recordUpdateCheck(new Date().toISOString());
    return { status: 'error', message: (err as Error).message };
  }
}
