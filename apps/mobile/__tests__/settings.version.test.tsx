// Settings → Updates (spec/11 § Mobile OTA, § Version reporting).
//
// Check now in the header; a status line (Up to date / Update available / Update
// ready) with one action; the auto-update toggle; Last checked. No versions are
// shown. updateCheck is mocked so every render/outcome branch is driven deterministically — their
// own logic is covered by their unit tests.

// Pin the timezone so formatWhen's local-time rendering is deterministic
// regardless of where the suite runs (Node reads TZ on the next Date op).
process.env.TZ = 'UTC';

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import type { VersionReport } from '@patch/wire';
import {
  UpdatesPage,
  formatWhen,
  useUpdatesBehind,
} from '../src/components/settings/VersionSection';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  byLabel,
  textOf,
  actAsync,
  flush,
} from './testUtils/render';
import { api } from '../src/api/rest';
import { __clearLastAlert, __getLastAlert } from './stubs/react-native';
import { __resetRouterMock } from './stubs/expo-router';
import { getLastCheckedAt, runUpdateCheck } from '../src/lib/updateCheck';
import { refreshPublishedApk, usePublishedApkStore } from '../src/lib/publishedApk';
import { installApk, useApkInstallStore } from '../src/lib/apkInstall';
import { updateSourceProblem } from '../src/lib/updateSource';
import * as Updates from 'expo-updates';
import { __setUseUpdates, __resetUseUpdates, __setEnabled } from './stubs/expo-updates';
import { reportHost, resetHosts, seedSettings } from './testUtils/settingsFixtures';

const wsMock = { send: vi.fn() };
vi.mock('../src/api/ws', () => ({ getWs: () => wsMock }));
vi.mock('../src/api/rest', () => ({ api: { version: vi.fn(), setPreferences: vi.fn() } }));
vi.mock('../src/lib/bootstrap', () => ({ teardown: vi.fn() }));
vi.mock('../src/lib/updateCheck', () => ({
  getLastCheckedAt: vi.fn(),
  runUpdateCheck: vi.fn(),
}));
// The real stores; only the network read and the install are stood in for.
vi.mock('../src/lib/publishedApk', async (orig) => ({
  ...(await orig<typeof import('../src/lib/publishedApk')>()),
  refreshPublishedApk: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/apkInstall', async (orig) => ({
  ...(await orig<typeof import('../src/lib/apkInstall')>()),
  installApk: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/updateSource', () => ({ updateSourceProblem: vi.fn() }));

const getLastCheckedAtMock = vi.mocked(getLastCheckedAt);
const runUpdateCheckMock = vi.mocked(runUpdateCheck);
const refreshMock = vi.mocked(refreshPublishedApk);
const installMock = vi.mocked(installApk);
const problemMock = vi.mocked(updateSourceProblem);
const publish = (apk: typeof NEEDS_INSTALL | null, error: string | null = null): void =>
  usePublishedApkStore.setState({ apk, error });

const REPORT: VersionReport = {
  checkedAt: '2026-09-24T10:00:00.000Z',
  server: {
    version: '0.1.900',
    gitSha: 'abc1234',
    builtAt: null,
    startedAt: '2026-09-24T09:00:00.000Z',
    serverSha: null,
  },
  web: null,
  daemon: null,
  hosts: [
    {
      hostId: 'd1',
      hostName: 'laptop',
      online: false,
      version: '0.1.899',
      gitSha: null,
      builtAt: null,
    },
  ],
  desktop: null,
  android: {
    version: '0.1.1',
    gitSha: 'f997fc3',
    builtAt: null,
    publishedAt: '2026-09-20T00:00:00.000Z',
    url: 'https://example.test/patch.apk',
  },
  clients: [],
  drift: [],
};

/** A published build on another native runtime: only installing reaches it. */
const NEEDS_INSTALL = {
  version: '0.1.1',
  gitSha: 'f997fc3',
  builtAt: '2026-09-18T10:34:48.609Z',
  url: 'https://example.test/patch.apk',
  newer: true,
  runtimeVersion: '0.1.7',
  needsInstall: true,
};

beforeEach(() => {
  vi.mocked(api.version).mockReset().mockResolvedValue(REPORT);
  wsMock.send.mockReset();
  __resetRouterMock();
  __clearLastAlert();
  resetHosts();
  getLastCheckedAtMock.mockReset().mockReturnValue(null);
  runUpdateCheckMock.mockReset().mockResolvedValue({ status: 'current' });
  refreshMock.mockClear();
  installMock.mockClear();
  publish(null);
  useApkInstallStore.setState({ state: { phase: 'idle' } });
  // A release build whose launch is checking its paired server.
  problemMock.mockReset().mockReturnValue(null);
  __resetUseUpdates();
  __setEnabled(true);
  vi.spyOn(Updates, 'reloadAsync').mockReset().mockResolvedValue();
});

async function mount(): Promise<ReactTestRenderer> {
  const r = renderRN(<UpdatesPage />);
  await flush();
  return r;
}

async function checkNow(r: ReactTestRenderer): Promise<void> {
  await actAsync(async () => {
    findHost(r.root, byTestId('check-updates')).props.onPress();
    await flush();
  });
}

const status = (r: ReactTestRenderer): string =>
  textOf(findHost(r.root, byTestId('update-status')));

describe('formatWhen', () => {
  it('is a short absolute timestamp', () => {
    expect(formatWhen('2026-07-31T13:07:00.000Z')).toBe('31 Jul 2026, 13:07');
    expect(formatWhen('2026-01-02T03:04:00.000Z')).toBe('2 Jan 2026, 03:04');
  });

  it('says Unavailable for an unparseable instant', () => {
    expect(formatWhen('not-a-date')).toBe('Unavailable');
  });
});

describe('Settings — Updates — page', () => {
  it('is titled Updates with Check now in the header', async () => {
    const r = await mount();
    expect(findHost(r.root, byTestId('settings-version'))).toBeTruthy();
    expect(textOf(findHost(r.root, byTestId('settings-page-title')))).toBe('Updates');
    const btn = findHost(r.root, byTestId('check-updates'));
    expect(textOf(btn)).toBe('Check now');
    expect(btn.props.disabled).toBe(false);
  });

  it('says Up to date, with no action, when nothing is behind; "Never" checked until it has been', async () => {
    reportHost('h1', { updateAvailable: false });
    const r = await mount();
    expect(status(r)).toBe('Up to date');
    expect(textOf(findHost(r.root, byTestId('update-last-checked')))).toBe('Never');
    expect(queryHost(r.root, byTestId('restart-to-update'))).toBeNull();
    expect(queryHost(r.root, byTestId('install-apk'))).toBeNull();
    expect(queryHost(r.root, byTestId('update-all'))).toBeNull();
  });

  it('shows when it was last checked', async () => {
    getLastCheckedAtMock.mockReturnValue('2026-07-31T09:00:00.000Z');
    const r = await mount();
    expect(textOf(findHost(r.root, byTestId('update-last-checked')))).toBe('31 Jul 2026, 09:00');
  });

  it('lists each host with its plain version, but no shas, layers or developer commands', async () => {
    reportHost('h1', { hostName: 'studio', hostVersion: '0.1.370', updateAvailable: true });
    publish(NEEDS_INSTALL);
    vi.mocked(api.version).mockResolvedValue({
      ...REPORT,
      drift: [{ kind: 'web-behind-server', detail: 'UI is behind', remedy: 'pnpm ship web' }],
    });
    const r = await mount();
    const all = textOf(r.root);
    expect(textOf(findHost(r.root, byTestId('version-host-h1')))).toContain('0.1.370');
    expect(all).not.toContain('f997fc3');
    expect(all).not.toContain('UI is behind');
    expect(all).not.toContain('pnpm ship web');
    expect(queryHost(r.root, byTestId('updates-versions'))).toBeNull();
    expect(queryHost(r.root, byTestId('updates-behind'))).toBeNull();
  });

  it('says Update available when the report has drift', async () => {
    vi.mocked(api.version).mockResolvedValue({
      ...REPORT,
      drift: [{ kind: 'web-behind-server', detail: 'UI is behind', remedy: 'pnpm ship web' }],
    });
    const r = await mount();
    expect(status(r)).toBe('Update available');
  });

  it('says Checking until the report arrives, not Up to date', () => {
    vi.mocked(api.version).mockReturnValue(new Promise(() => {}));
    const r = renderRN(<UpdatesPage />);
    expect(status(r)).toBe('Checking for updates…');
  });

  it('a failed read says it could not check, with Retry, never Up to date', async () => {
    vi.mocked(api.version).mockRejectedValueOnce(new Error('HTTP 502'));
    const r = await mount();
    expect(status(r)).toBe("Couldn't check for updates: HTTP 502");
    await actAsync(async () => {
      findHost(r.root, byLabel('Retry')).props.onPress();
      await flush();
    });
    expect(queryHost(r.root, byTestId('version-error'))).toBeNull();
    expect(status(r)).toBe('Up to date');
  });
});

describe('Settings — Updates — this app', () => {
  // Once a newer bundle has been downloaded, `checkForUpdateAsync` reports
  // nothing further — the page must not say "Up to date" while the phone still
  // runs the OLD bundle.
  it('says an update is ready, and offers ONE tap to apply it, when one is pending', async () => {
    __setUseUpdates({ isUpdatePending: true });
    const r = await mount();
    expect(status(r)).toBe('Update ready');
    const btn = findHost(r.root, byTestId('restart-to-update'));
    expect(textOf(btn)).toBe('Restart to update');
    btn.props.onPress();
    expect(Updates.reloadAsync).toHaveBeenCalled();
  });

  it('a check that downloads an update switches straight to the restart action', async () => {
    runUpdateCheckMock.mockResolvedValue({ status: 'downloaded' });
    const r = await mount();
    expect(queryHost(r.root, byTestId('restart-to-update'))).toBeNull();
    await checkNow(r);
    expect(status(r)).toBe('Update ready');
    findHost(r.root, byTestId('restart-to-update')).props.onPress();
    expect(Updates.reloadAsync).toHaveBeenCalled();
  });

  it('Check now: "Checking…" (disabled) while in flight, then "Up to date", the new check time, and a re-read', async () => {
    let resolveCheck!: (v: { status: 'current' }) => void;
    runUpdateCheckMock.mockReturnValue(new Promise((res) => (resolveCheck = res)));
    const r = await mount();
    expect(api.version).toHaveBeenCalledTimes(1);
    await checkNow(r);
    const btn = findHost(r.root, byTestId('check-updates'));
    expect(textOf(btn)).toBe('Checking…');
    expect(btn.props.disabled).toBe(true);
    expect(status(r)).toBe('Checking for updates…');
    getLastCheckedAtMock.mockReturnValue('2026-09-27T08:15:00.000Z');
    await actAsync(async () => {
      resolveCheck({ status: 'current' });
      await flush();
    });
    expect(status(r)).toBe('Up to date');
    expect(textOf(findHost(r.root, byTestId('check-updates')))).toBe('Check now');
    expect(textOf(findHost(r.root, byTestId('update-last-checked')))).toBe('27 Sep 2026, 08:15');
    expect(api.version).toHaveBeenCalledTimes(2);
  });

  it('is busy while expo-updates itself is checking or downloading', async () => {
    __setUseUpdates({ isChecking: true });
    const r = await mount();
    expect(textOf(findHost(r.root, byTestId('check-updates')))).toBe('Checking…');
    expect(status(r)).toBe('Checking for updates…');
    __setUseUpdates({ isChecking: false, isDownloading: true });
    const r2 = await mount();
    expect(findHost(r2.root, byTestId('check-updates')).props.disabled).toBe(true);
    expect(status(r2)).toBe('Downloading update…');
  });

  it('surfaces a failed check rather than claiming to be current', async () => {
    runUpdateCheckMock.mockResolvedValue({ status: 'error', message: 'network down' });
    const r = await mount();
    await checkNow(r);
    expect(status(r)).toBe("Couldn't check for updates: network down");
  });

  it('surfaces expo-updates’ own check error too', async () => {
    __setUseUpdates({ checkError: new Error('manifest 500') });
    const r = await mount();
    expect(status(r)).toBe("Couldn't check for updates: manifest 500");
  });

  // A launch not yet checking its server says why, rather than reading as current.
  it('says why there is no update check when this launch has none', async () => {
    problemMock.mockReturnValue(
      'Updates from this server start at the next launch. Restart the app.',
    );
    const r = await mount();
    expect(status(r)).toBe('Updates from this server start at the next launch. Restart the app.');
  });

  // A native change bumps `runtimeVersion`, and the server offers that phone
  // nothing over the air — which would read as "Up to date".
  it('a build that needs installing says Update available, and Update installs it in place', async () => {
    publish(NEEDS_INSTALL);
    const r = await mount();
    await checkNow(r);
    expect(status(r)).toBe('Update available');
    const button = findHost(r.root, byTestId('install-apk'));
    expect(textOf(button)).toBe('Update');
    await actAsync(() => button.props.onPress());
    expect(installMock).toHaveBeenCalledWith('https://example.test/patch.apk', '0.1.1');
    expect(refreshMock).toHaveBeenCalled();
  });

  it('shows the download as it happens, without a version, and holds the button', async () => {
    publish(NEEDS_INSTALL);
    useApkInstallStore.setState({
      state: { phase: 'downloading', version: '0.1.1', fraction: 0.5 },
    });
    const r = await mount();
    expect(status(r)).toBe('Downloading update · 50%');
    const button = findHost(r.root, byTestId('install-apk'));
    expect(textOf(button)).toBe('Installing…');
    expect(button.props.disabled ?? button.props.accessibilityState?.disabled).toBeTruthy();
  });

  it('offers no install for a newer build this phone gets over the air', async () => {
    publish({ ...NEEDS_INSTALL, runtimeVersion: '0.1.6', needsInstall: false });
    const r = await mount();
    expect(queryHost(r.root, byTestId('install-apk'))).toBeNull();
    expect(status(r)).toBe('Up to date');
  });

  it('a failed APK lookup offers nothing', async () => {
    publish(null, 'HTTP 502');
    const r = await mount();
    expect(queryHost(r.root, byTestId('install-apk'))).toBeNull();
  });

  it('a pending OTA wins over a build to install: restart only', async () => {
    __setUseUpdates({ isUpdatePending: true });
    publish(NEEDS_INSTALL);
    const r = await mount();
    expect(findHost(r.root, byTestId('restart-to-update'))).toBeTruthy();
    expect(queryHost(r.root, byTestId('install-apk'))).toBeNull();
  });
});

describe('Settings — Updates — hosts behind', () => {
  it('says Update available and offers one Update that updates every online host behind, and no other', async () => {
    reportHost('h1', { updateAvailable: true });
    reportHost('h2', { updateAvailable: true });
    reportHost('h3', { updateAvailable: false });
    reportHost('h4', { updateAvailable: true }, false);
    const r = await mount();
    expect(status(r)).toBe('Update available');
    expect(queryHost(r.root, byTestId('updates-host-h1'))).toBeNull();
    await actAsync(() => findHost(r.root, byTestId('update-all')).props.onPress());
    expect(wsMock.send).toHaveBeenCalledTimes(2);
    expect(wsMock.send).toHaveBeenCalledWith({ type: 'host.update', hostId: 'h1' });
    expect(wsMock.send).toHaveBeenCalledWith({ type: 'host.update', hostId: 'h2' });
  });

  it('a host held for running chats says so, offers no Update, and Update now asks before forcing', async () => {
    reportHost('h1', { updateAvailable: true, updateHeld: true });
    const r = await mount();
    expect(status(r)).toBe('Updating when your chats are idle');
    expect(queryHost(r.root, byTestId('update-all'))).toBeNull();
    expect(textOf(findHost(r.root, byTestId('version-host-h1')))).toContain(
      'Update waiting for chats to finish',
    );
    await actAsync(() => findHost(r.root, byTestId('update-now-h1')).props.onPress());
    expect(wsMock.send).not.toHaveBeenCalled();
    const confirm = __getLastAlert()?.buttons?.find((b) => b.text === 'Update now');
    await actAsync(() => confirm?.onPress?.());
    expect(wsMock.send).toHaveBeenCalledWith({ type: 'host.update', hostId: 'h1', force: true });
  });

  it('offers no Update when the only host behind is offline', async () => {
    reportHost('h1', { updateAvailable: true }, false);
    const r = await mount();
    expect(status(r)).toBe('Update available');
    expect(queryHost(r.root, byTestId('update-all'))).toBeNull();
  });
});

describe('Settings — Updates — update mode', () => {
  it('automatic by default; the toggle writes the shared setting', async () => {
    seedSettings();
    vi.mocked(api.setPreferences).mockResolvedValue({ preferences: {} } as never);
    const r = await mount();
    const toggle = findHost(r.root, byTestId('auto-update'));
    expect(toggle.props.value).toBe(true);
    await actAsync(async () => {
      toggle.props.onValueChange(false);
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ autoUpdateHosts: false });
  });
});

describe('useUpdatesBehind', () => {
  function Harness(): React.ReactElement {
    const b = useUpdatesBehind();
    return React.createElement('Text', { testID: 'behind' }, b ? 'yes' : 'no');
  }
  async function read(): Promise<string> {
    const r = renderRN(<Harness />);
    await flush();
    return textOf(findHost(r.root, byTestId('behind')));
  }

  it('is false when nothing is behind', async () => {
    reportHost('h1', { updateAvailable: false });
    publish({ ...NEEDS_INSTALL, needsInstall: false });
    expect(await read()).toBe('no');
  });

  it('is true when an OTA update is pending', async () => {
    __setUseUpdates({ isUpdatePending: true });
    expect(await read()).toBe('yes');
  });

  it('is true when a build needs installing', async () => {
    publish(NEEDS_INSTALL);
    expect(await read()).toBe('yes');
  });

  it('is true when any host has an update available', async () => {
    reportHost('h1', { updateAvailable: false });
    reportHost('h2', { updateAvailable: true });
    expect(await read()).toBe('yes');
  });

  it('is false when the APK lookup fails', async () => {
    publish(null, 'HTTP 502');
    expect(await read()).toBe('no');
  });
});
