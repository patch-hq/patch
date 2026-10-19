// Installing a new build from inside the app (spec/11 § Mobile updates): the
// installer, the published-build store that decides whether one is needed, and
// the banner that offers it.
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  textOf,
  actAsync,
  flush,
} from './testUtils/render';
import { __clearAllMmkv } from './stubs/mmkv';
import * as FileSystem from './stubs/expo-file-system';
import * as IntentLauncher from './stubs/expo-intent-launcher';
import { installApk, useApkInstallStore } from '../src/lib/apkInstall';
import { refreshPublishedApk, usePublishedApkStore } from '../src/lib/publishedApk';
import { AppUpdateBanner } from '../src/components/AppUpdateBanner';
import { useUiStore } from '../src/stores/uiStore';

const NEEDS_INSTALL = {
  version: '1.2.3',
  gitSha: 'abc1234',
  builtAt: '2099-01-01T00:00:00.000Z',
  url: 'https://patch.test/api/download/patch-1.2.3.apk',
  newer: true,
  runtimeVersion: '0.1.7',
  needsInstall: true,
};

beforeEach(() => {
  __clearAllMmkv();
  FileSystem.__resetDownloads();
  IntentLauncher.__started.length = 0;
  IntentLauncher.__setStartError(null);
  useApkInstallStore.setState({ state: { phase: 'idle' } });
  usePublishedApkStore.setState({ apk: null, error: null });
  useUiStore.setState({ errors: [] });
  vi.unstubAllGlobals();
});

describe('installApk', () => {
  it('downloads the APK and hands it to Android’s installer, readable by it', async () => {
    const phases: string[] = [];
    const unsub = useApkInstallStore.subscribe((s) => phases.push(s.state.phase));
    await installApk(NEEDS_INSTALL.url, '1.2.3');
    unsub();
    expect(FileSystem.__downloads).toEqual([
      { url: NEEDS_INSTALL.url, fileUri: 'file:///cache/patch-1.2.3.apk' },
    ]);
    expect(IntentLauncher.__started).toEqual([
      {
        action: 'android.intent.action.VIEW',
        params: {
          data: 'content://patch.files/cache/patch-1.2.3.apk',
          flags: 1,
          type: 'application/vnd.android.package-archive',
        },
      },
    ]);
    expect(phases).toEqual(['downloading', 'downloading', 'downloading', 'installing', 'idle']);
  });

  it('says why when the download fails, and installs nothing', async () => {
    FileSystem.__setDownload({ status: 404 });
    await installApk(NEEDS_INSTALL.url, '1.2.3');
    expect(useApkInstallStore.getState().state).toEqual({
      phase: 'error',
      version: '1.2.3',
      message: 'the download answered HTTP 404',
    });
    expect(IntentLauncher.__started).toEqual([]);
    expect(useUiStore.getState().errors.map((e) => e.message)).toEqual([
      'Could not install Patch 1.2.3: the download answered HTTP 404',
    ]);
  });

  it('says why when the installer cannot be opened', async () => {
    IntentLauncher.__setStartError(new Error('No Activity found to handle Intent'));
    await installApk(NEEDS_INSTALL.url, '1.2.3');
    expect(useApkInstallStore.getState().state).toMatchObject({
      phase: 'error',
      message: 'No Activity found to handle Intent',
    });
  });

  it('does not start a second install while one is under way', async () => {
    useApkInstallStore.setState({
      state: { phase: 'downloading', version: '1.2.3', fraction: 0.1 },
    });
    await installApk(NEEDS_INSTALL.url, '1.2.3');
    expect(FileSystem.__downloads).toEqual([]);
  });
});

describe('refreshPublishedApk', () => {
  it('reads what the server publishes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...NEEDS_INSTALL, file: 'patch-1.2.3.apk' }), {
            status: 200,
          }),
      ),
    );
    await refreshPublishedApk();
    expect(usePublishedApkStore.getState().apk).toMatchObject({
      version: '1.2.3',
      needsInstall: true,
    });
  });

  it('keeps the failure rather than reporting nothing to install', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 502 })),
    );
    await refreshPublishedApk();
    expect(usePublishedApkStore.getState().error).toBe('android-latest.json returned HTTP 502');
  });

  // A phone reaching its server through the relay has no address to download
  // from: it hears of a new build from the install notification instead.
  it('reads nothing on a route through the relay', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { setRoute } = await import('../src/config');
    setRoute({ kind: 'relay', relay: { url: 'wss://relay.test', channel: 'c', serverKey: 'k' } });
    await refreshPublishedApk();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AppUpdateBanner', () => {
  it('is absent unless a build needs installing', async () => {
    usePublishedApkStore.setState({ apk: { ...NEEDS_INSTALL, needsInstall: false } });
    const r = renderRN(<AppUpdateBanner />);
    await flush();
    expect(queryHost(r.root, byTestId('app-update-banner'))).toBeNull();
  });

  it('offers the install, and taps through to it', async () => {
    usePublishedApkStore.setState({ apk: NEEDS_INSTALL });
    const r = renderRN(<AppUpdateBanner />);
    await flush();
    const banner = findHost(r.root, byTestId('app-update-banner'));
    expect(textOf(banner)).toBe('Install Patch 1.2.3');
    await actAsync(async () => {
      banner.props.onPress();
      await flush();
    });
    expect(IntentLauncher.__started).toHaveLength(1);
  });

  it('shows the download’s progress', async () => {
    usePublishedApkStore.setState({ apk: NEEDS_INSTALL });
    useApkInstallStore.setState({
      state: { phase: 'downloading', version: '1.2.3', fraction: 0.42 },
    });
    const r = renderRN(<AppUpdateBanner />);
    await flush();
    expect(textOf(findHost(r.root, byTestId('app-update-banner')))).toBe(
      'Downloading Patch 1.2.3 · 42%',
    );
  });
});
