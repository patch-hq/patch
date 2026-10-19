// Settings → Updates (spec/11 § Mobile OTA, § Version reporting;
// design/settings-redesign; project rule: every app shows its current version,
// running build, last check date, and a manual check).
//
// Check now in the header; Behind — each thing that is behind with the action
// that fixes it (Restart to update, Install, a host's Update, drift with its
// remedy); Versions — this app and every layer from GET /api/version at
// once; Last checked with the status sentence. buildInfo + updateCheck are
// mocked so every render/outcome branch is driven deterministically — their
// own logic is covered by their unit tests.

// Pin the timezone so formatWhen's local-time rendering is deterministic
// regardless of where the suite runs (Node reads TZ on the next Date op).
process.env.TZ = 'UTC';

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
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
  hasText,
  textOf,
  actAsync,
  flush,
} from './testUtils/render';
import { api } from '../src/api/rest';
import { __clearLastAlert, __getLastAlert } from './stubs/react-native';
import { __resetRouterMock } from './stubs/expo-router';
import { mobileBuildInfo } from '../src/lib/buildInfo';
import { getLastCheckedAt, runUpdateCheck } from '../src/lib/updateCheck';
import { refreshPublishedApk, usePublishedApkStore } from '../src/lib/publishedApk';
import { installApk, useApkInstallStore } from '../src/lib/apkInstall';
import { updateSourceProblem } from '../src/lib/updateSource';
import * as Updates from 'expo-updates';
import { __setUseUpdates, __resetUseUpdates, __setEnabled } from './stubs/expo-updates';
import { reportHost, resetHosts } from './testUtils/settingsFixtures';

const wsMock = { send: vi.fn() };
vi.mock('../src/api/ws', () => ({ getWs: () => wsMock }));
vi.mock('../src/api/rest', () => ({ api: { version: vi.fn() } }));
vi.mock('../src/lib/bootstrap', () => ({ teardown: vi.fn() }));
vi.mock('../src/lib/buildInfo', () => ({ mobileBuildInfo: vi.fn() }));
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

const buildInfoMock = vi.mocked(mobileBuildInfo);
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
  buildInfoMock.mockReset().mockReturnValue({ version: 'dev' });
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
const behind = (r: ReactTestRenderer): ReactTestInstance | null =>
  queryHost(r.root, byTestId('updates-behind'));

/** The subtitle under a ValueRow's label: the Text after the title in its column. */
function rowText(r: ReactTestRenderer, valueTestID: string): string {
  let node = findHost(r.root, byTestId(valueTestID)).parent!;
  // Climb to the Row's outer View (the one holding both columns).
  let hops = 0;
  while (hops < 3) {
    node = node.parent!;
    if (node.type === 'View') hops++;
  }
  return textOf(node);
}

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

  it('shows what is running, when it was built, and when it was last checked', async () => {
    buildInfoMock.mockReturnValue({
      version: '0.1.343',
      gitSha: 'a059a40',
      builtAt: '2026-07-31T13:07:00.000Z',
    });
    getLastCheckedAtMock.mockReturnValue('2026-07-31T09:00:00.000Z');
    const r = await mount();
    expect(textOf(findHost(r.root, byTestId('version-this-app')))).toBe('0.1.343 · a059a40');
    expect(rowText(r, 'version-this-app')).toContain('built 31 Jul 2026, 13:07');
    expect(textOf(findHost(r.root, byTestId('update-last-checked')))).toBe('31 Jul 2026, 09:00');
  });

  it('a bare version, no built line, "Never" checked and no status line when nothing is stamped', async () => {
    const r = await mount();
    expect(textOf(findHost(r.root, byTestId('version-this-app')))).toBe('dev');
    expect(rowText(r, 'version-this-app')).toBe('This appdev');
    expect(textOf(findHost(r.root, byTestId('update-last-checked')))).toBe('Never');
    expect(queryHost(r.root, byTestId('update-status'))).toBeNull();
    expect(hasText(r.root, 'Last checked')).toBe(true);
  });

  it('renders "built Unavailable" for an unparseable builtAt (never a crash)', async () => {
    buildInfoMock.mockReturnValue({ version: 'dev', builtAt: 'not-a-date' });
    const r = await mount();
    expect(rowText(r, 'version-this-app')).toContain('built Unavailable');
  });

  it('draws no Behind group when nothing is behind', async () => {
    reportHost('h1', { updateAvailable: false });
    const r = await mount();
    expect(behind(r)).toBeNull();
    expect(queryHost(r.root, byTestId('restart-to-update'))).toBeNull();
    expect(queryHost(r.root, byTestId('install-apk'))).toBeNull();
  });
});

describe('Settings — Updates — this app', () => {
  // THE bug this panel was rebuilt for. Once a newer bundle has been downloaded,
  // `checkForUpdateAsync` reports nothing further available — so the panel said
  // "Up to date" while the phone was still running the OLD bundle.
  it('says an update is ready, and offers ONE tap to apply it, when one is pending', async () => {
    __setUseUpdates({ isUpdatePending: true });
    const r = await mount();
    expect(status(r)).toBe('An update is downloaded and ready to install.');
    expect(hasText(r.root, 'Up to date.')).toBe(false);
    const group = behind(r)!;
    expect(hasText(group, 'Behind')).toBe(true);
    expect(hasText(group, 'Downloaded')).toBe(true);
    const btn = findHost(group, byTestId('restart-to-update'));
    expect(textOf(btn)).toBe('Restart to update');
    btn.props.onPress();
    expect(Updates.reloadAsync).toHaveBeenCalled();
  });

  it('a check that downloads an update switches straight to the restart action', async () => {
    runUpdateCheckMock.mockResolvedValue({ status: 'downloaded' });
    const r = await mount();
    expect(behind(r)).toBeNull();
    await checkNow(r);
    expect(status(r)).toBe('An update is downloaded and ready to install.');
    findHost(r.root, byTestId('restart-to-update')).props.onPress();
    expect(Updates.reloadAsync).toHaveBeenCalled();
  });

  it('Check now: "Checking…" (disabled) while in flight, then "Up to date.", the new check time, and a re-read of every layer', async () => {
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
    expect(status(r)).toBe('Up to date.');
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

  // A launch not yet checking its server (newly paired, or relayed) says why,
  // rather than reading as current (spec/11 § Mobile updates).
  it('says why there is no update check when this launch has none', async () => {
    problemMock.mockReturnValue(
      'Updates from this server start at the next launch. Restart the app.',
    );
    const r = await mount();
    expect(status(r)).toBe('Updates from this server start at the next launch. Restart the app.');
  });

  // A native change bumps `runtimeVersion`, and the server offers that phone
  // nothing over the air — which would read as "Up to date". The published
  // build on another runtime is offered instead, and installs in place.
  it('a build that needs installing says so, and Install installs it in place', async () => {
    publish(NEEDS_INSTALL);
    buildInfoMock.mockReturnValue({ version: '0.1.0' });
    const r = await mount();
    await checkNow(r);
    expect(status(r)).toBe('A new build needs installing.');
    expect(hasText(r.root, 'Up to date.')).toBe(false);
    expect(hasText(behind(r)!, '0.1.0 → 0.1.1')).toBe(true);
    const button = findHost(r.root, byTestId('install-apk'));
    expect(textOf(button)).toBe('Install');
    await actAsync(() => button.props.onPress());
    expect(installMock).toHaveBeenCalledWith('https://example.test/patch.apk', '0.1.1');
    // Check now re-reads the published build too.
    expect(refreshMock).toHaveBeenCalled();
  });

  it('shows the download as it happens, and holds the button until it is done', async () => {
    publish(NEEDS_INSTALL);
    useApkInstallStore.setState({
      state: { phase: 'downloading', version: '0.1.1', fraction: 0.5 },
    });
    const r = await mount();
    expect(status(r)).toBe('Downloading Patch 0.1.1 · 50%');
    const button = findHost(r.root, byTestId('install-apk'));
    expect(textOf(button)).toBe('Installing…');
    expect(button.props.disabled ?? button.props.accessibilityState?.disabled).toBeTruthy();
  });

  it('offers no install for a newer build this phone gets over the air', async () => {
    publish({ ...NEEDS_INSTALL, runtimeVersion: '0.1.6', needsInstall: false });
    const r = await mount();
    expect(queryHost(r.root, byTestId('install-apk'))).toBeNull();
    expect(behind(r)).toBeNull();
  });

  it('a failed APK lookup offers nothing and says nothing of its own', async () => {
    publish(null, 'HTTP 502');
    const r = await mount();
    expect(queryHost(r.root, byTestId('install-apk'))).toBeNull();
    expect(queryHost(r.root, byTestId('update-status'))).toBeNull();
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
  it('lists each host with an update, by name and host version, with Update', async () => {
    reportHost('h1', { hostName: 'studio', hostVersion: '0.1.370', updateAvailable: true });
    reportHost('h2', { hostName: 'attic', updateAvailable: true });
    reportHost('h3', { hostName: 'current', updateAvailable: false });
    const r = await mount();
    const group = behind(r)!;
    const row = findHost(group, byTestId('updates-host-h1'));
    expect(textOf(row)).toBe('studio host0.1.370Update');
    expect(findHost(group, byTestId('updates-host-h2'))).toBeTruthy();
    expect(queryHost(group, byTestId('updates-host-h3'))).toBeNull();
    // Sorted by name.
    const text = textOf(group);
    expect(text.indexOf('attic host')).toBeLessThan(text.indexOf('studio host'));
  });

  it('Update sends host.update to that host', async () => {
    reportHost('h1', { updateAvailable: true });
    const r = await mount();
    await actAsync(() => findHost(r.root, byTestId('updates-host-h1-update')).props.onPress());
    expect(wsMock.send).toHaveBeenCalledWith({ type: 'host.update', hostId: 'h1' });
  });

  it('Update to an offline host sends nothing and says why', async () => {
    reportHost('h1', { updateAvailable: true }, false);
    const r = await mount();
    await actAsync(() => findHost(r.root, byTestId('updates-host-h1-update')).props.onPress());
    expect(wsMock.send).not.toHaveBeenCalled();
    expect(__getLastAlert()?.title).toBe('Update failed');
    expect(__getLastAlert()?.message).toMatch(/h1 is offline/);
  });
});

describe('Settings — Updates — cross-layer report (GET /api/version)', () => {
  it('lists every layer at once, with no disclosure', async () => {
    const r = await mount();
    expect(api.version).toHaveBeenCalled();
    expect(queryHost(r.root, byTestId('version-details-toggle'))).toBeNull();
    expect(textOf(findHost(r.root, byTestId('version-detail-server')))).toBe('0.1.900 · abc1234');
    expect(textOf(findHost(r.root, byTestId('version-detail-host-d1')))).toBe('0.1.899 · offline');
    expect(textOf(findHost(r.root, byTestId('version-detail-android')))).toBe('0.1.1 · f997fc3');
    expect(queryHost(r.root, byTestId('version-detail-web'))).toBeNull();
    const versions = findHost(r.root, byTestId('updates-versions'));
    expect(hasText(versions, 'laptop host')).toBe(true);
    expect(hasText(versions, 'Android APK')).toBe(true);
  });

  it('names web, a host without a name, and every client, in layer order', async () => {
    vi.mocked(api.version).mockResolvedValue({
      ...REPORT,
      web: {
        version: '0.1.899',
        gitSha: null,
        builtAt: null,
        bundle: 'assets/index.js',
        deployedAt: '2026-09-24T09:00:00.000Z',
        expectedServerSha: null,
      },
      hosts: [
        {
          hostId: 'd2',
          hostName: null,
          online: true,
          version: '0.1.900',
          gitSha: 'abc1234',
          builtAt: null,
        },
      ],
      android: null,
      clients: [
        {
          surfaceId: 's1',
          surfaceKind: 'desktop',
          online: true,
          version: '0.1.900',
          gitSha: null,
          builtAt: null,
          lastSeenAt: '2026-09-24T09:00:00.000Z',
        },
        {
          surfaceId: 's2',
          surfaceKind: 'mobile',
          online: false,
          version: '0.1.800',
          gitSha: 'deadbee',
          builtAt: null,
          lastSeenAt: '2026-09-24T09:00:00.000Z',
        },
      ],
    });
    const r = await mount();
    expect(textOf(findHost(r.root, byTestId('version-detail-web')))).toBe('0.1.899');
    expect(textOf(findHost(r.root, byTestId('version-detail-host-d2')))).toBe('0.1.900 · abc1234');
    expect(textOf(findHost(r.root, byTestId('version-detail-client-s1')))).toBe('0.1.900');
    expect(textOf(findHost(r.root, byTestId('version-detail-client-s2')))).toBe(
      '0.1.800 · deadbee · offline',
    );
    expect(queryHost(r.root, byTestId('version-detail-android'))).toBeNull();
    const text = textOf(findHost(r.root, byTestId('updates-versions')));
    const order = ['This app', 'Web UI', 'Server', 'd2 host', 'desktop', 'mobile'].map((s) =>
      text.indexOf(s),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('a layer with no version reads "unknown"', async () => {
    vi.mocked(api.version).mockResolvedValue({
      ...REPORT,
      hosts: [
        {
          hostId: 'd3',
          hostName: 'new',
          online: true,
          version: null,
          gitSha: null,
          builtAt: null,
        },
      ],
    });
    const r = await mount();
    expect(textOf(findHost(r.root, byTestId('version-detail-host-d3')))).toBe('unknown');
  });

  it('shows a loading row until the report arrives', () => {
    vi.mocked(api.version).mockReturnValue(new Promise(() => {}));
    const r = renderRN(<UpdatesPage />);
    expect(findHost(r.root, byLabel('Loading'))).toBeTruthy();
    expect(queryHost(r.root, byTestId('version-detail-server'))).toBeNull();
  });

  it('lists each drift in Behind, its detail as the title and its remedy under it', async () => {
    vi.mocked(api.version).mockResolvedValue({
      ...REPORT,
      drift: [
        { kind: 'web-behind-server', detail: 'UI is behind', remedy: 'pnpm ship web' },
        { kind: 'surface-behind-deployed', detail: 'Desktop is old', remedy: 'Restart it' },
      ],
    });
    const r = await mount();
    const group = behind(r)!;
    expect(textOf(findHost(group, byTestId('version-drift-web-behind-server')))).toBe(
      'UI is behindpnpm ship web',
    );
    expect(textOf(findHost(group, byTestId('version-drift-surface-behind-deployed')))).toBe(
      'Desktop is oldRestart it',
    );
  });

  it('a failed read is shown with a Retry, never as "all layers agree"', async () => {
    vi.mocked(api.version).mockRejectedValueOnce(new Error('HTTP 502'));
    const r = await mount();
    expect(textOf(findHost(r.root, byTestId('version-error')))).toBe(
      'Couldn’t read versions: HTTP 502',
    );
    expect(queryHost(r.root, byTestId('version-detail-server'))).toBeNull();
    // This app's own version still shows.
    expect(findHost(r.root, byTestId('version-this-app'))).toBeTruthy();
    await actAsync(async () => {
      findHost(r.root, byLabel('Retry')).props.onPress();
      await flush();
    });
    expect(queryHost(r.root, byTestId('version-error'))).toBeNull();
    expect(findHost(r.root, byTestId('version-detail-server'))).toBeTruthy();
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
