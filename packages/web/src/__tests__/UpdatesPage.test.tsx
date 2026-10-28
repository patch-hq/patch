// Settings → Updates.
//
// It replaces a Settings line that read "server <sha>" — accurate about the server
// and silent about the UI, which is how prod served an 8-day-old SPA for a week
// with nothing in the product able to say so. So these tests are mostly about the
// page refusing to look healthy when it isn't: drift is shown with a remedy, a
// machine with a newer host waiting is listed with an Update button, a shell
// that cannot self-update says why, and a failed check never reads as fine.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { VersionReport } from '@patch/wire';
import { UpdatesPage } from '../routes/settings/UpdatesPage.js';
import { SettingsRoute } from '../routes/SettingsRoute.js';
import { useSettingsHostStore } from '../routes/settings/hostScope.js';
import { ErrorToasts } from '../components/ErrorToasts.js';
import type { DesktopUpdaterState } from '../lib/desktopBridge.js';
import { setActiveWs, type PatchWs } from '../api/ws.js';
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
  await waitFor(() => expect(screen.getByTestId('version-checked')).not.toHaveTextContent('—'));
}

function fakeWs(): { send: ReturnType<typeof vi.fn> } {
  const ws = { send: vi.fn() };
  setActiveWs(ws as unknown as PatchWs);
  return ws;
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
  const installBridge = (
    state: DesktopUpdaterState,
    extra: Record<string, unknown> = {},
  ): { check: ReturnType<typeof vi.fn> } => {
    const check = vi.fn(async () => state);
    (window as unknown as { patch: unknown }).patch = {
      getUpdaterState: vi.fn(async () => state),
      checkForUpdates: check,
      onUpdaterState: vi.fn(() => () => {}),
      ...extra,
    };
    return { check };
  };

  it('says Up to date, with no Update button, when nothing is behind', async () => {
    stubFetch(null);
    reportHost('host-a', { hostName: 'laptop', updateAvailable: false });
    renderPage();
    await loaded();
    expect(screen.getByTestId('update-status')).toHaveTextContent('Up to date');
    expect(screen.queryByTestId('update-all')).toBeNull();
  });

  it('does not claim to be up to date before the check has answered', async () => {
    stubFetch(null);
    renderPage();
    expect(screen.getByTestId('update-status')).toHaveTextContent('Checking…');
    await loaded();
  });

  it('lists each host with its plain version, never shas or developer commands', async () => {
    stubFetch({ drift: DRIFT });
    reportHost('host-a', { hostName: 'laptop', hostVersion: '0.1.300', updateAvailable: true });
    renderPage();
    await loaded();
    expect(screen.getByTestId('version-host-host-a')).toHaveTextContent('0.1.300');
    const text = screen.getByTestId('settings-version').textContent ?? '';
    expect(text).not.toContain('9b8635f');
    expect(text).not.toContain('pnpm');
    expect(screen.queryByTestId('version-rows')).toBeNull();
    expect(screen.queryByTestId('version-drift')).toBeNull();
  });

  it('says a host is waiting for chats, with no Update button, when its update is held', async () => {
    stubFetch(null);
    reportHost('host-a', { hostName: 'laptop', updateAvailable: true, updateHeld: true });
    usePresenceStore.getState().setHostOnline('host-a', true);
    renderPage();
    await loaded();
    expect(screen.getByTestId('update-status')).toHaveTextContent(
      'Updating when your chats are idle',
    );
    expect(screen.getByTestId('version-host-host-a')).toHaveTextContent(
      'Update waiting for chats to finish',
    );
    expect(screen.queryByTestId('update-all')).toBeNull();
  });

  it('Update now on a held host forces the install, but only after confirming', async () => {
    stubFetch(null);
    reportHost('host-a', { hostName: 'laptop', updateAvailable: true, updateHeld: true });
    usePresenceStore.getState().setHostOnline('host-a', true);
    const send = vi.fn();
    setActiveWs({ send } as unknown as PatchWs);
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    renderPage();
    await loaded();
    fireEvent.click(screen.getByTestId('update-now-host-a'));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('update-now-host-a'));
    expect(send).toHaveBeenCalledWith({ type: 'host.update', hostId: 'host-a', force: true });
    confirm.mockRestore();
  });

  it('does not double-report the agent lagging the server when a host row already says so', async () => {
    stubFetch({
      drift: [
        {
          kind: 'daemon-server-mismatch',
          detail: 'the agent (1.1.580) is a different build to the server (1.1.594)',
          remedy: 'pnpm ship server',
        },
      ],
    });
    reportHost('host-a', { hostName: 'laptop', updateAvailable: true, updateHeld: true });
    renderPage();
    await loaded();
    expect(screen.getByTestId('update-status')).toHaveTextContent(
      'Updating when your chats are idle',
    );
  });

  it('says Update available when the report has drift, without printing it', async () => {
    stubFetch({ drift: DRIFT });
    renderPage();
    await loaded();
    expect(screen.getByTestId('update-status')).toHaveTextContent('Update available');
    expect(screen.getByTestId('settings-version')).not.toHaveTextContent('ship both together');
  });

  it('shows the check time and refetches on Check now', async () => {
    const fetchMock = stubFetch(null);
    renderPage();
    await loaded();
    expect(screen.getByTestId('version-checked')).toHaveTextContent('just now');
    const button = screen.getByTestId('version-check-now');
    expect(button).toHaveTextContent('Check now');
    const before = versionCalls(fetchMock);
    fireEvent.click(button);
    await waitFor(() => expect(versionCalls(fetchMock)).toBeGreaterThan(before));
  });

  it('says Checking… and disables Check now while a check is in flight', async () => {
    let release: (() => void) | null = null;
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return json(REPORT);
        return new Promise<Response>((resolve) => {
          release = () => resolve(json(REPORT));
        });
      }),
    );
    renderPage();
    await loaded();
    fireEvent.click(screen.getByTestId('version-check-now'));
    await waitFor(() => expect(screen.getByTestId('version-check-now')).toBeDisabled());
    expect(screen.getByTestId('version-check-now')).toHaveTextContent('Checking…');
    release!();
    await waitFor(() => expect(screen.getByTestId('version-check-now')).toBeEnabled());
  });

  it('surfaces a failed read instead of claiming to be up to date', async () => {
    stubFetch(null, 401);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('version-error')).toBeInTheDocument());
    expect(screen.getByTestId('settings-version')).toHaveTextContent('unauthenticated');
    expect(screen.getByTestId('version-checked')).toHaveTextContent('—');
    expect(screen.getByTestId('update-status')).not.toHaveTextContent('Up to date');
  });

  it('retries after a failed read', async () => {
    const fetchMock = stubFetch(null, 401);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('version-error')).toBeInTheDocument());
    const before = versionCalls(fetchMock);
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(versionCalls(fetchMock)).toBeGreaterThan(before));
  });

  describe('a host with a newer host waiting', () => {
    it('Update sends host.update to every online host that is behind, only', async () => {
      stubFetch(null);
      const ws = fakeWs();
      reportHost('host-a', { hostName: 'laptop', updateAvailable: true });
      usePresenceStore.getState().setHostOnline('host-a', true);
      reportHost('host-b', { hostName: 'mac', updateAvailable: true });
      usePresenceStore.getState().setHostOnline('host-b', true);
      reportHost('host-c', { hostName: 'box', updateAvailable: false });
      usePresenceStore.getState().setHostOnline('host-c', true);
      renderPage();
      await loaded();
      expect(screen.getByTestId('update-status')).toHaveTextContent('Update available');
      fireEvent.click(screen.getByTestId('update-all'));
      expect(ws.send).toHaveBeenCalledTimes(2);
      expect(ws.send).toHaveBeenCalledWith({ type: 'host.update', hostId: 'host-a' });
      expect(ws.send).toHaveBeenCalledWith({ type: 'host.update', hostId: 'host-b' });
    });

    it('offers no Update when the only host behind is offline', async () => {
      stubFetch(null);
      reportHost('host-a', { hostName: 'laptop', updateAvailable: true });
      usePresenceStore.getState().setHostOnline('host-a', false);
      renderPage();
      await loaded();
      expect(screen.getByTestId('update-status')).toHaveTextContent('Update available');
      expect(screen.queryByTestId('update-all')).toBeNull();
    });
  });

  describe('update mode', () => {
    it('is automatic by default, and the toggle writes the shared setting', async () => {
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
  });

  describe('inside the Electron shell', () => {
    it('shows no desktop row or version when the shell is current', async () => {
      stubFetch(null);
      installBridge(shellState());
      renderPage();
      await loaded();
      expect(screen.queryByTestId('version-shell')).toBeNull();
      expect(screen.getByTestId('update-status')).toHaveTextContent('Up to date');
    });

    it('reports a staged update as ready to restart', async () => {
      stubFetch(null);
      installBridge(
        shellState({ lastResult: 'downloaded', downloaded: true, availableVersion: '0.1.320' }),
      );
      renderPage();
      await waitFor(() =>
        expect(screen.getByTestId('update-status')).toHaveTextContent('restart to apply'),
      );
      expect(screen.getByTestId('settings-version')).not.toHaveTextContent('0.1.320');
    });

    it('names an install failure as such, not as a failed check', async () => {
      stubFetch(null);
      installBridge(
        shellState({ lastResult: 'error', lastError: 'disk full', lastErrorKind: 'install' }),
      );
      renderPage();
      await waitFor(() =>
        expect(screen.getByTestId('version-shell-error')).toHaveTextContent(
          'Last update install failed',
        ),
      );
    });

    it('never renders a failed check as up to date', async () => {
      stubFetch(null);
      installBridge(shellState({ lastResult: 'error', lastError: 'offline' }));
      renderPage();
      await waitFor(() => expect(screen.getByTestId('version-shell-error')).toBeInTheDocument());
      expect(screen.getByTestId('version-shell-error')).toHaveTextContent(
        'Last update check failed',
      );
    });

    it('checks the shell too when Check now is pressed', async () => {
      stubFetch(null);
      const { check } = installBridge(shellState());
      renderPage();
      await loaded();
      fireEvent.click(screen.getByTestId('version-check-now'));
      await waitFor(() => expect(check).toHaveBeenCalled());
    });

    it('tolerates a bridge with no state-push subscription or check hook', async () => {
      stubFetch(null);
      installBridge(shellState(), { onUpdaterState: undefined, checkForUpdates: undefined });
      renderPage();
      await loaded();
      fireEvent.click(screen.getByTestId('version-check-now'));
      expect(screen.getByTestId('update-status')).toBeInTheDocument();
    });
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
