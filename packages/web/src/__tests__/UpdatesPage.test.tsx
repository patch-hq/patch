// Settings → Updates: one switch over every part of Patch (spec/11 § One update switch).
// On: the server and hosts move together in the background, so the page only
// reports. Off: nothing moves until "Update everything". The user never manages
// parts one by one, and a failed check never reads as fine.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { VersionReport } from '@patch/wire';
import { AUTO_ON_HINT, UPDATE_ALL_HINT, UpdatesPage } from '../routes/settings/UpdatesPage.js';
import { SettingsRoute } from '../routes/SettingsRoute.js';
import { useSettingsHostStore } from '../routes/settings/hostScope.js';
import { ErrorToasts } from '../components/ErrorToasts.js';
import type { DesktopUpdaterState } from '../lib/desktopBridge.js';
import { setActiveWs } from '../api/ws.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { clearHosts, reportHost } from './presenceHelpers.js';
import { makeFetch, preferencesServer } from './settingsHarness.js';
import { loadShared, resetShared } from './sharedHelpers.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';

const REPORT: VersionReport = {
  checkedAt: '2026-07-28T12:00:00.000Z',
  server: {
    version: '0.1.317',
    gitSha: '9b8635f',
    builtAt: '2026-07-28T10:00:00.000Z',
    startedAt: '2026-07-28T11:00:00.000Z',
    serverSha: '9b8635f',
  },
  web: {
    version: '0.1.317',
    gitSha: '9b8635f',
    builtAt: '2026-07-28T10:00:00.000Z',
    bundle: 'assets/index-CtWBatg1.js',
    expectedServerSha: '9b8635f',
    deployedAt: '2026-07-28T10:05:00.000Z',
  },
  daemon: { version: '0.1.317', gitSha: '9b8635f', builtAt: null, online: true },
  desktop: {
    version: '0.1.317',
    gitSha: '9b8635f',
    builtAt: null,
    publishedAt: '2026-07-28T10:10:00.000Z',
    url: '/api/desktop/Patch-0.1.317-arm64-mac.zip',
  },
  android: {
    version: '0.1.317',
    gitSha: '9b8635f',
    builtAt: null,
    publishedAt: '2026-07-28T10:20:00.000Z',
    url: '/api/download/patch-9b8635f.apk',
  },
  clients: [],
  hosts: [
    {
      hostId: 'host-a',
      hostName: 'host-a',
      online: true,
      version: '0.1.300',
      gitSha: 'abc1234',
      builtAt: '2026-07-25T09:00:00.000Z',
    },
  ],
  drift: [],
};

const DRIFT: VersionReport['drift'] = [
  {
    kind: 'web-server-mismatch',
    detail: 'the deployed SPA (0.1.305 / f6a6326) is OLDER than the server (0.1.317 / 9b8635f)',
    remedy: 'ship both together: pnpm ship all',
  },
];

const SETTINGS_PAYLOAD = {
  account: { accountId: 'acct-123', userPublicKey: 'acct-123', createdAt: 1 },
  devices: [],
  push: { tokenCount: 0 },
  daemon: { registered: true, status: 'online', lastConnectedAt: 1700000000000 },
  projectFolders: [],
};

function shellState(over: Partial<DesktopUpdaterState> = {}): DesktopUpdaterState {
  return {
    currentVersion: '0.1.317',
    gitSha: '9b8635f',
    builtAt: '2026-07-28T10:00:00.000Z',
    feedUrl: 'https://patch.tomchambers.me/api/desktop/',
    disabledReason: null,
    lastCheckedAt: '2026-07-28T11:55:00.000Z',
    lastResult: 'up-to-date',
    lastError: null,
    lastErrorKind: null,
    availableVersion: null,
    downloaded: false,
    checking: false,
    staleSince: null,
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** /api/version answers the report (or a failure); everything else a plain OK. */
function stubFetch(report: Partial<VersionReport> | null, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/api/version')) {
      return status === 200
        ? json({ ...REPORT, ...report })
        : json({ error: 'unauthenticated' }, status);
    }
    if (u.includes('/api/settings')) return json(SETTINGS_PAYLOAD);
    if (u.includes('/api/usage-report')) return json({ samples: [], chats: [] });
    if (u.includes('/api/secrets')) return json({ secrets: [] });
    return json({ ok: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function versionCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/version')).length;
}

function renderPage(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/updates']}>
        <UpdatesPage />
        <ErrorToasts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

/** Wait for the report itself, not just the page: the server row needs data. */
async function loaded(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('version-server')).not.toHaveTextContent('—'));
}

beforeEach(() => {
  clearHosts();
  useSettingsHostStore.setState({ selected: null });
  useUiStore.getState().clearToasts();
  useUiStore.getState().resolveConfirm(false);
  usePresenceStore.getState().setConnection('connected');
  setActiveWs(null);
  resetShared();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setActiveWs(null);
  delete (window as unknown as { patch?: unknown }).patch;
});

describe('UpdatesPage', () => {
  const installBridge = (state: DesktopUpdaterState): { check: ReturnType<typeof vi.fn> } => {
    const check = vi.fn(async () => state);
    (window as unknown as { patch: unknown }).patch = {
      getUpdaterState: vi.fn(async () => state),
      checkForUpdates: check,
      onUpdaterState: vi.fn(() => () => {}),
    };
    return { check };
  };

  describe('auto-update on', () => {
    beforeEach(() => loadShared({ settings: { autoUpdateHosts: true } }));

    it('says Up to date and explains the switch, with nothing to press', async () => {
      stubFetch(null);
      reportHost('host-a', { hostName: 'laptop', updateAvailable: false });
      renderPage();
      await loaded();
      expect(screen.getByTestId('update-status')).toHaveTextContent('Up to date');
      expect(screen.getByTestId('auto-update')).toHaveTextContent(AUTO_ON_HINT);
      expect(screen.getByTestId('version-server')).toHaveTextContent('0.1.317');
      expect(screen.getByTestId('version-last-updated')).not.toHaveTextContent('—');
      expect(screen.queryByTestId('update-all')).toBeNull();
    });

    it('a host catching up reads as Updating…, still with nothing to press', async () => {
      stubFetch(null);
      reportHost('host-a', { hostName: 'laptop', updateAvailable: true });
      renderPage();
      await loaded();
      expect(screen.getByTestId('update-status')).toHaveTextContent('Updating…');
      expect(screen.queryByTestId('update-all')).toBeNull();
    });

    it('never prints shas or developer commands', async () => {
      stubFetch({ drift: DRIFT });
      renderPage();
      await loaded();
      expect(screen.getByTestId('settings-version').textContent ?? '').not.toMatch(/[0-9a-f]{7,}/);
      expect(screen.getByTestId('settings-version')).not.toHaveTextContent('pnpm');
    });

    it('does not claim to be up to date before the check has answered', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise(() => {})),
      );
      renderPage();
      expect(screen.getByTestId('update-status')).toHaveTextContent('Checking…');
    });
  });

  describe('auto-update off', () => {
    beforeEach(() => loadShared({ settings: { autoUpdateHosts: false } }));

    it('offers a newer release as one Update everything', async () => {
      const fetchMock = stubFetch({
        release: { available: '0.1.320', autoUpdate: false, updating: false },
      });
      renderPage();
      await loaded();
      expect(screen.getByTestId('version-available')).toHaveTextContent('0.1.320');
      expect(screen.getByTestId('update-all-row')).toHaveTextContent(UPDATE_ALL_HINT);
      expect(screen.getByTestId('auto-update')).not.toHaveTextContent(AUTO_ON_HINT);
      fireEvent.click(screen.getByTestId('update-all'));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            (c) =>
              String(c[0]).includes('/api/update-all') &&
              (c[1] as RequestInit | undefined)?.method === 'POST',
          ),
        ).toBe(true),
      );
      expect(screen.getByTestId('update-all')).toBeDisabled();
      expect(screen.getByTestId('update-all')).toHaveTextContent('Updating…');
    });

    it('with nothing newer, says Up to date and offers nothing', async () => {
      stubFetch({ release: { available: '0.1.317', autoUpdate: false, updating: false } });
      renderPage();
      await loaded();
      expect(screen.getByTestId('update-status')).toHaveTextContent('Up to date');
      expect(screen.queryByTestId('update-all')).toBeNull();
      expect(screen.queryByTestId('version-available')).toBeNull();
    });
  });

  it('surfaces a failed read instead of claiming to be up to date', async () => {
    stubFetch(null, 401);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('version-error')).toBeInTheDocument());
    expect(screen.getByTestId('settings-version')).toHaveTextContent('unauthenticated');
    expect(screen.getByTestId('settings-version')).not.toHaveTextContent('Up to date');
  });

  it('retries after a failed read', async () => {
    const fetchMock = stubFetch(null, 401);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('version-error')).toBeInTheDocument());
    const before = versionCalls(fetchMock);
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(versionCalls(fetchMock)).toBeGreaterThan(before));
  });

  it('the toggle writes the one shared setting', async () => {
    const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
    loadShared({ settings: { autoUpdateHosts: true } });
    const inner = stubFetch(null).getMockImplementation()!;
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (url: string, init?: RequestInit) =>
        url.includes('/api/version') ? inner(url) : server.handler(url, init),
      ),
    );
    renderPage();
    await loaded();
    const toggle = screen.getByTestId('auto-update-toggle');
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(server.writes).toContainEqual({ autoUpdateHosts: false }));
  });

  it('Check now checks the shell too', async () => {
    const fetchMock = stubFetch(null);
    const { check } = installBridge(shellState());
    renderPage();
    await loaded();
    const before = versionCalls(fetchMock);
    fireEvent.click(screen.getByTestId('version-check-now'));
    await waitFor(() => expect(versionCalls(fetchMock)).toBeGreaterThan(before));
    expect(check).toHaveBeenCalled();
  });
});

describe('Settings nav → Updates pip', () => {
  function renderAtUsage(): QueryClient {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/settings/usage']}>
          <Routes>
            <Route path="/settings/*" element={<SettingsRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return qc;
  }

  /** The pip is decided by the version report, so wait until it has landed. */
  async function reportLanded(qc: QueryClient): Promise<void> {
    await waitFor(() => expect(screen.getByTestId('settings-nav')).toBeInTheDocument());
    await waitFor(() => expect(qc.getQueryData(['version'])).toBeDefined());
  }

  it('is absent when nothing is behind', async () => {
    stubFetch(null);
    reportHost('host-a', { hostName: 'laptop', updateAvailable: false });
    const qc = renderAtUsage();
    await reportLanded(qc);
    expect(screen.getByTestId('settings-usage')).toBeInTheDocument();
    expect(screen.getByTestId('settings-nav-updates')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-nav-updates-pip')).toBeNull();
  });

  it('appears when a host has an update waiting', async () => {
    stubFetch(null);
    reportHost('host-a', { hostName: 'laptop', updateAvailable: true });
    renderAtUsage();
    await waitFor(() =>
      expect(
        within(screen.getByTestId('settings-nav-updates')).getByTestId('settings-nav-updates-pip'),
      ).toBeInTheDocument(),
    );
  });

  it('appears when the version report has drift', async () => {
    stubFetch({ drift: DRIFT });
    renderAtUsage();
    await waitFor(() =>
      expect(
        within(screen.getByTestId('settings-nav-updates')).getByTestId('settings-nav-updates-pip'),
      ).toBeInTheDocument(),
    );
  });

  it('goes when the host catches up', async () => {
    stubFetch(null);
    reportHost('host-a', { hostName: 'laptop', updateAvailable: true });
    const qc = renderAtUsage();
    await reportLanded(qc);
    expect(screen.getByTestId('settings-nav-updates-pip')).toBeInTheDocument();
    reportHost('host-a', { hostName: 'laptop', updateAvailable: false });
    await waitFor(() => expect(screen.queryByTestId('settings-nav-updates-pip')).toBeNull());
  });
});
