// Install a new APK from inside the app (spec/11 § Mobile updates).
//
// A release whose native code changed cannot arrive over the air, so the phone
// has to install it. Before this the only way was Settings → Updates →
// "Download APK", which opened the browser to download it and left the install
// to the Downloads app. Here the app downloads it itself, shows the progress,
// and hands the file to Android's installer — which still asks the user to
// confirm, as Android requires for anything installed outside a store.
//
// NO FALLBACK: every failure lands in `error` and is pushed to the user.

import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { create } from 'zustand';
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

/** Download `url` (the APK for `version`) and open Android's installer on it. */
export async function installApk(url: string, version: string): Promise<void> {
  const now = useApkInstallStore.getState().state;
  if (now.phase === 'downloading' || now.phase === 'installing') return;
  const dir = FileSystem.cacheDirectory;
  try {
    if (!dir) throw new Error('no cache directory to download into');
    set({ phase: 'downloading', version, fraction: null });
    const target = `${dir}patch-${version}.apk`;
    const download = FileSystem.createDownloadResumable(url, target, {}, (p) => {
      const fraction =
        p.totalBytesExpectedToWrite > 0 ? p.totalBytesWritten / p.totalBytesExpectedToWrite : null;
      set({ phase: 'downloading', version, fraction });
    });
    const result = await download.downloadAsync();
    if (!result) throw new Error('the download was cancelled');
    if (result.status !== 200) throw new Error(`the download answered HTTP ${result.status}`);
    set({ phase: 'installing', version });
    const contentUri = await FileSystem.getContentUriAsync(result.uri);
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
