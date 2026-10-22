// Install a new APK from inside the app (spec/11 § Mobile updates).
//
// A release whose native code changed cannot arrive over the air, so the phone
// has to install it. Before this the only way was Settings → Updates →
// "Download APK", which opened the browser to download it and left the install
// to the Downloads app. Here the app downloads it itself, shows the progress,
// and hands the file to Android's installer — which still asks the user to
// confirm, as Android requires for anything installed outside a store.
//
// The app also downloads a new build on its own as soon as it hears of one
// (stageApk) and notifies, so Install is usually instant.
//
// NO FALLBACK: every failure lands in `error` and is pushed to the user.

import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Notifications from 'expo-notifications';
import { create } from 'zustand';
import { store } from './credential';
import { useUiStore } from '../stores/uiStore';

/** `Intent.FLAG_GRANT_READ_URI_PERMISSION`: lets the installer read our file. */
const FLAG_GRANT_READ_URI_PERMISSION = 1;
const APK_MIME = 'application/vnd.android.package-archive';

export type ApkInstallState =
  | { phase: 'idle' }
  | { phase: 'downloading'; version: string; fraction: number | null }
  | { phase: 'installing'; version: string }
  | { phase: 'error'; version: string; message: string };

export const useApkInstallStore = create<{ state: ApkInstallState }>(() => ({
  state: { phase: 'idle' },
}));

const set = (state: ApkInstallState): void => useApkInstallStore.setState({ state });

const NOTIFIED_KEY = 'patch.apk.notifiedVersion';

/** Download the APK into the cache, or return it if a finished copy is already
 *  there. Written as `.part` and renamed, so a half-file is never taken for it. */
async function downloadApk(url: string, version: string): Promise<string> {
  const dir = FileSystem.cacheDirectory;
  if (!dir) throw new Error('no cache directory to download into');
  const target = `${dir}patch-${version}.apk`;
  if ((await FileSystem.getInfoAsync(target)).exists) return target;
  set({ phase: 'downloading', version, fraction: null });
  const part = `${target}.part`;
  const download = FileSystem.createDownloadResumable(url, part, {}, (p) => {
    const fraction =
      p.totalBytesExpectedToWrite > 0 ? p.totalBytesWritten / p.totalBytesExpectedToWrite : null;
    set({ phase: 'downloading', version, fraction });
  });
  const result = await download.downloadAsync();
  if (!result) throw new Error('the download was cancelled');
  if (result.status !== 200) throw new Error(`the download answered HTTP ${result.status}`);
  await FileSystem.moveAsync({ from: part, to: target });
  return target;
}

/** Download `url` (the APK for `version`) and open Android's installer on it.
 *  A copy staged in the background (stageApk) is installed without downloading. */
export async function installApk(url: string, version: string): Promise<void> {
  const now = useApkInstallStore.getState().state;
  if (now.phase === 'downloading' || now.phase === 'installing') return;
  try {
    const uri = await downloadApk(url, version);
    set({ phase: 'installing', version });
    const contentUri = await FileSystem.getContentUriAsync(uri);
    // Resolves when the installer screen closes, whatever the user chose there:
    // a completed install replaces this app before that, so reaching the next
    // line means it was not installed and the offer stays open.
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      flags: FLAG_GRANT_READ_URI_PERMISSION,
      type: APK_MIME,
    });
    set({ phase: 'idle' });
  } catch (err) {
    const message = (err as Error).message;
    set({ phase: 'error', version, message });
    useUiStore.getState().pushError(`Could not install Patch ${version}: ${message}`);
  }
}

/**
 * Download a published build ahead of time and tell the user it is ready.
 * Called when the app learns of a build that needs installing; nothing is
 * opened. Notifies once per version — tapping the notification installs the
 * staged file at once (notificationLink `app-update`).
 */
export async function stageApk(url: string, version: string): Promise<void> {
  const now = useApkInstallStore.getState().state;
  if (now.phase === 'downloading' || now.phase === 'installing') return;
  if (store().getString(NOTIFIED_KEY) === version) return;
  try {
    await downloadApk(url, version);
    set({ phase: 'idle' });
    await Notifications.scheduleNotificationAsync({
      identifier: `app-update-${version}`,
      content: {
        title: `Patch ${version} is ready to install`,
        body: 'Tap to install',
        data: { kind: 'app-update', deepLink: url },
      },
      trigger: null,
    });
    store().set(NOTIFIED_KEY, version);
  } catch (err) {
    const message = (err as Error).message;
    set({ phase: 'error', version, message });
    useUiStore.getState().pushError(`Could not download Patch ${version}: ${message}`);
  }
}
