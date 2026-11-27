// Settings (design/settings-redesign): one page per address, /settings/<page>,
// beside a nav grouped Agents / Setup / System. This file covers the shell —
// the nav, the addresses, the host switcher, what was removed — and the
// Account, Devices, Voice, Agent and Manager pages. Usage (accounts), MCP,
// Memories, Hosts, Providers and Updates each have a file of their own.
//
// Backed by /api/auth/me, /api/settings and the live per-host reports.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import {
  DEFAULT_GOAL_EVAL_PROMPT,
  DEFAULT_LINK_SUMMARY_PROMPT,
  DEFAULT_MANAGER_PROMPT,
} from '@patch/wire';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useSettingsHostStore } from '../routes/settings/hostScope.js';
import { SETTINGS_PAGES } from '../routes/settings/pages.js';
import { DEFAULT_DICTATE_CHORD } from '../lib/dictateChord.js';
import { clearHosts, reportHost } from './presenceHelpers.js';
import { setActiveWs } from '../api/ws.js';
import {
  ME_PAYLOAD,
  SETTINGS_PAYLOAD,
  json,
  makeFetch,
  preferencesServer,
  renderSettings,
  resetSettingsState,
} from './settingsHarness.js';
import { loadShared } from './sharedHelpers.js';
import { PERMISSION_MODES } from '../components/Composer.js';

/** Each page's own testid, so a test can say which page is showing. */
const PAGE_TESTID: Record<string, string> = {
  usage: 'settings-usage',
  chats: 'settings-chats',
  agent: 'settings-agent',
  mcp: 'settings-mcp',
  memories: 'settings-memories',
  manager: 'settings-manager-page',
  experimental: 'settings-experimental-page',
  goals: 'settings-goals-page',
  dictation: 'settings-dictation',
  meetings: 'settings-meetings',
  voice: 'settings-voice',
  hooks: 'settings-hooks-page',
  computer: 'settings-computer-use',
  activity: 'settings-activity',
  hosts: 'settings-hosts',
  identity: 'settings-identity',
  providers: 'settings-providers',
  notifications: 'settings-notifications',
  devices: 'settings-devices',
  shortcuts: 'settings-shortcuts',
  updates: 'settings-version',
  account: 'settings-account',
  bugs: 'settings-bugs',
};

const errors = (): string[] => useUiStore.getState().errors.map((e) => e.message);

beforeEach(() => {
  resetSettingsState();
  // One host, online, that has not described itself yet.
  usePresenceStore.getState().setHostOnline('d1', true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setActiveWs(null);
});

describe('Settings shell — one pane tab, pages as internal state', () => {
  it('lists every page in the nav, in order, under Setup / Agents / Voice / App', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings');
    const nav = await screen.findByTestId('settings-nav');
    // Scoped to the page links themselves — `within(nav)` also catches the
    // Back/Forward history buttons sharing this nav's head.
    const buttons = within(nav)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-testid')?.startsWith('settings-nav-'));
    const collapsed = [
      'AI accounts',
      'Hosts',
      'Linked devices',
      'Connected services',
      'Notifications',
      'Agent',
      'Chats',
      'Goals',
      'Memories',
      'Manager',
      'Voice calls',
      'Dictation',
      'Meetings',
      'Advanced ▸',
      'Shortcuts',
      'Updates',
      'Experimental features',
      'Bug reports',
      'Account',
    ];
    expect(buttons.map((a) => a.textContent)).toEqual(collapsed);
    expect(
      within(nav)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(['Setup', 'Agents', 'Voice', 'App']);
    // Experimental pages are marked in the nav.
    expect(
      within(within(nav).getByTestId('settings-nav-manager')).getByLabelText('Experimental'),
    ).toBeTruthy();
    // Expert pages stay folded away until asked for.
    fireEvent.click(within(nav).getByTestId('settings-nav-advanced'));
    const open = within(nav)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-testid')?.startsWith('settings-nav-'))
      .filter((b) => b.getAttribute('data-testid') !== 'settings-nav-advanced');
    expect(open.map((a) => a.textContent)).toEqual(
      expect.arrayContaining([
        'Tools (MCP)',
        'Hooks',
        'Computer use',
        'Agent identity',
        'Activity log',
      ]),
    );
  });

  it('every page says what it is for in one line', async () => {
    vi.stubGlobal('fetch', makeFetch());
    for (const p of SETTINGS_PAGES) {
      const view = renderSettings(`/settings/${p.id}`);
      await waitFor(() => expect(screen.getByTestId(PAGE_TESTID[p.id]!)).toBeInTheDocument());
      expect(screen.getByTestId('settings-intro').textContent?.length).toBeGreaterThan(10);
      view.unmount();
    }
  });

  it.each(SETTINGS_PAGES.map((p) => p.id))('the %s link opens that page', async (id) => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings');
    fireEvent.click(await screen.findByTestId('settings-nav-advanced'));
    fireEvent.click(await screen.findByTestId(`settings-nav-${id}`));
    await waitFor(() => expect(screen.getByTestId(PAGE_TESTID[id]!)).toBeInTheDocument());
    expect(screen.getByTestId('settings-route')).toHaveAttribute('data-page', id);
    // The nav marks where you are, and only there.
    expect(screen.getByTestId(`settings-nav-${id}`)).toHaveAttribute('aria-current', 'page');
    for (const other of SETTINGS_PAGES.filter((p) => p.id !== id)) {
      expect(screen.getByTestId(`settings-nav-${other.id}`)).not.toHaveAttribute('aria-current');
    }
  });

  it('a /settings/<page> deep link opens that page directly (e.g. a banner elsewhere)', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings/agent');
    await waitFor(() => expect(screen.getByTestId('settings-agent')).toBeInTheDocument());
    expect(screen.getByTestId('settings-route')).toHaveAttribute('data-page', 'agent');
  });

  it('/settings itself shows Usage beside the nav, and is not an opened page', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings');
    await waitFor(() => expect(screen.getByTestId('settings-usage')).toBeInTheDocument());
    const route = screen.getByTestId('settings-route');
    expect(route).toHaveAttribute('data-page', 'index');
    // `.open` is what swaps the nav for the page on a phone; the index is the list.
    expect(route).not.toHaveClass('open');
    // Desktop shows Usage beside the nav even at the bare index — the nav
    // still marks it current.
    expect(screen.getByTestId('settings-nav-usage')).toHaveAttribute('aria-current', 'page');
  });

  it('says so on every page when the server cannot read its stored accounts and keys', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings/agent');
    await waitFor(() => expect(screen.getByTestId('settings-agent')).toBeInTheDocument());
    expect(screen.queryByTestId('settings-secrets-problem')).toBeNull();
    const problem =
      "The stored accounts and keys can't be read: /data/secrets.key is missing. Put back the secrets.key that goes with it, or delete /data/secrets.json and add the accounts and keys again.";
    act(() => void loadShared({ problem }));
    expect(screen.getByTestId('settings-secrets-problem')).toHaveTextContent(problem);
  });

  it('a named page is opened, so a phone shows it over the list', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings/agent');
    await waitFor(() => expect(screen.getByTestId('settings-agent')).toBeInTheDocument());
    expect(screen.getByTestId('settings-route')).toHaveClass('open');
  });

  it('an unknown page shows the index (Usage) rather than a blank', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings/nope');
    await waitFor(() => expect(screen.getByTestId('settings-usage')).toBeInTheDocument());
    expect(screen.getByTestId('settings-route')).not.toHaveClass('open');
  });

  it('the back arrow on a page returns to the list', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings/devices');
    await screen.findByTestId('settings-devices');
    fireEvent.click(await screen.findByTestId('settings-back'));
    await waitFor(() => expect(screen.getByTestId('settings-route')).not.toHaveClass('open'));
    expect(screen.getByTestId('settings-usage')).toBeInTheDocument();
  });

  it('shows a route-level error with a working Retry when /api/settings fails', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u, init) =>
        u.includes('/api/settings') && (init?.method ?? 'GET') === 'GET' && fail
          ? json({ error: 'boom' }, 500)
          : null,
      ),
    );
    renderSettings('/settings/devices');
    await waitFor(() => expect(screen.getByTestId('settings-error')).toBeInTheDocument());
    expect(screen.getByTestId('settings-error')).toHaveTextContent('Failed to load settings');
    fail = false;
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.getByTestId('settings-route')).toBeInTheDocument());
  });

  it('keeps the preferences store in step with what /api/settings serves', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({
        preferences: { ...usePreferencesStore.getState().preferences, addressWord: 'jeeves' },
      }),
    );
    renderSettings('/settings/manager');
    await waitFor(() => expect(screen.getByTestId('manager-address-word')).toHaveValue('jeeves'));
    expect(usePreferencesStore.getState().preferences.addressWord).toBe('jeeves');
  });

  // spec/14 § Copy — no helper text. The settings pages carry titles and values
  // only; an empty state is the one sanctioned helper line. This was guarded
  // solely by a browser test, so adding a `.hint` cost a whole deploy to find.
  it.each(SETTINGS_PAGES.map((p) => p.id))('%s renders no explainer prose', async (id) => {
    vi.stubGlobal('fetch', makeFetch());
    reportHost('d1');
    const { container } = renderSettings(`/settings/${id}`);
    await waitFor(() => expect(screen.getByTestId(PAGE_TESTID[id]!)).toBeInTheDocument());
    expect(container.querySelectorAll('.settings-route .hint')).toHaveLength(0);
  });
});

describe('Settings nav — Updates pip', () => {
  it('shows no pip while nothing is behind', async () => {
    vi.stubGlobal('fetch', makeFetch());
    reportHost('d1');
    renderSettings('/settings/account');
    await waitFor(() => expect(screen.getByTestId('settings-account')).toBeInTheDocument());
    expect(screen.queryByTestId('settings-nav-updates-pip')).toBeNull();
  });

  it('marks Updates from every page while a host has an update waiting', async () => {
    vi.stubGlobal('fetch', makeFetch());
    reportHost('d1', { updateAvailable: true });
    renderSettings('/settings/account');
    await waitFor(() => expect(screen.getByTestId('settings-nav-updates-pip')).toBeInTheDocument());
  });
});

// Only what belongs to one host is chosen per host now — MCP servers and
// Claude Code's memory entries (spec/01 § Settings). Memories is the page used
// here: which host it shows is said by its unreported/empty line.
describe('Settings host switcher (per-host pages)', () => {
  it('is not drawn while only one host has reported — there is nothing to choose', async () => {
    vi.stubGlobal('fetch', makeFetch());
    reportHost('d1', { hostName: 'mac' });
    renderSettings('/settings/memories');
    await waitFor(() =>
      expect(screen.getByTestId('host-d1-memory-unreported')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('settings-host-switch')).toBeNull();
  });

  it('is drawn with two, defaulting to the only online host', async () => {
    vi.stubGlobal('fetch', makeFetch());
    reportHost('d1', { hostName: 'mac', runsManager: false });
    reportHost('d2', { hostName: 'hetzner', runsManager: true });
    usePresenceStore.getState().setHostOnline('d2', true);
    renderSettings('/settings/memories');
    const sw = await screen.findByTestId('settings-host-switch');
    expect(
      within(sw)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['hetzner', 'mac']);
    expect(screen.getByTestId('settings-host-d2')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('host-d2-memory-unreported')).toBeInTheDocument();
    expect(screen.queryByTestId('host-d1-memory-unreported')).toBeNull();
  });

  it('switching hosts changes which host the page shows, and the choice is shared', async () => {
    vi.stubGlobal('fetch', makeFetch());
    reportHost('d1', { hostName: 'mac', runsManager: false });
    reportHost('d2', { hostName: 'hetzner', runsManager: true });
    renderSettings('/settings/memories');
    fireEvent.click(await screen.findByTestId('settings-host-d1'));
    await waitFor(() =>
      expect(screen.getByTestId('host-d1-memory-unreported')).toBeInTheDocument(),
    );
    expect(useSettingsHostStore.getState().selected).toBe('d1');
    fireEvent.click(screen.getByTestId('settings-nav-advanced'));
    fireEvent.click(screen.getByTestId('settings-nav-mcp'));
    await waitFor(() =>
      expect(screen.getByTestId('settings-host-d1')).toHaveAttribute('aria-selected', 'true'),
    );
  });

  it('is not drawn on a page of shared settings', async () => {
    vi.stubGlobal('fetch', makeFetch());
    reportHost('d1', { hostName: 'mac', runsManager: false });
    reportHost('d2', { hostName: 'hetzner', runsManager: true });
    renderSettings('/settings/agent');
    await waitFor(() => expect(screen.getByTestId('permission-default')).toBeInTheDocument());
    expect(screen.queryByTestId('settings-host-switch')).toBeNull();
  });

  it('forgets a chosen host that has gone, falling back to the only online one', async () => {
    vi.stubGlobal('fetch', makeFetch());
    usePresenceStore.getState().setHostOnline('d1', false);
    reportHost('d2', { hostName: 'hetzner', runsManager: true });
    usePresenceStore.getState().setHostOnline('d2', true);
    useSettingsHostStore.setState({ selected: 'gone' });
    renderSettings('/settings/memories');
    await waitFor(() =>
      expect(screen.getByTestId('host-d2-memory-unreported')).toBeInTheDocument(),
    );
  });

  it('says there are no hosts rather than drawing empty controls', async () => {
    vi.stubGlobal('fetch', makeFetch());
    clearHosts();
    renderSettings('/settings/memories');
    await waitFor(() =>
      expect(screen.getByTestId('settings-no-hosts')).toHaveTextContent('No hosts yet'),
    );
  });

  it('says a chosen host has not reported, naming it by id', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings/memories');
    await waitFor(() =>
      expect(screen.getByTestId('settings-host-unreported')).toHaveTextContent(
        'd1 hasn’t reported yet',
      ),
    );
  });
});

describe('Settings → Account', () => {
  it('renders account id from /api/auth/me (no "this surface" line)', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings/account');
    await waitFor(() => expect(screen.getByTestId('account-id')).toHaveTextContent('acct-123'));
    // The opaque "this surface" id was removed from the UI — it was debug noise.
    expect(screen.queryByTestId('surface-id')).toBeNull();
  });

  it('names the server this surface talks to and the build it runs', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u) =>
        u.includes('/api/healthz') ? json({ ok: true, version: '1', gitSha: 'abc1234' }) : null,
      ),
    );
    renderSettings('/settings/account');
    await waitFor(() => expect(screen.getByTestId('build-sha')).toHaveTextContent('abc1234'));
    expect(screen.getByTestId('build-origin')).toHaveTextContent(window.location.origin);
  });

  describe('remote access (spec/10 § Relay)', () => {
    const relayOn = (over: Record<string, unknown>) =>
      makeFetch({}, (u) =>
        u.includes('/api/relay')
          ? json({
              enabled: true,
              url: 'wss://relay.example.com',
              channel: 'chan',
              serverKey: 'key',
              connected: true,
              sessions: 0,
              lastError: null,
              ...over,
            })
          : null,
      );

    it('says nothing when the server has no relay', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetch({}, (u) => (u.includes('/api/relay') ? json({ enabled: false }) : null)),
      );
      renderSettings('/settings/account');
      await waitFor(() => expect(screen.getByTestId('account-id')).toBeInTheDocument());
      expect(screen.queryByTestId('relay-line')).toBeNull();
    });

    it('says the server is reachable through its relay, and how many devices are on it', async () => {
      vi.stubGlobal('fetch', relayOn({ sessions: 2 }));
      renderSettings('/settings/account');
      await waitFor(() =>
        expect(screen.getByTestId('relay-state')).toHaveTextContent(
          'Reachable through relay.example.com · 2 connected',
        ),
      );
    });

    it('says plainly when the relay cannot be reached, and why', async () => {
      vi.stubGlobal('fetch', relayOn({ connected: false, lastError: 'ECONNREFUSED' }));
      renderSettings('/settings/account');
      await waitFor(() =>
        expect(screen.getByTestId('relay-state')).toHaveTextContent(
          'Not reachable through relay.example.com: ECONNREFUSED',
        ),
      );
    });

    it('does not say "connected" when nobody is', async () => {
      vi.stubGlobal('fetch', relayOn({}));
      renderSettings('/settings/account');
      await waitFor(() =>
        expect(screen.getByTestId('relay-state')).toHaveTextContent(
          'Reachable through relay.example.com',
        ),
      );
      expect(screen.getByTestId('relay-state')).not.toHaveTextContent('connected');
    });

    it('says plainly when the relay cannot be reached and gives no reason', async () => {
      vi.stubGlobal('fetch', relayOn({ connected: false }));
      renderSettings('/settings/account');
      await waitFor(() =>
        expect(screen.getByTestId('relay-state')).toHaveTextContent(
          'Not reachable through relay.example.com',
        ),
      );
      expect(screen.getByTestId('relay-state')).not.toHaveTextContent(':');
    });
  });

  it('renders without crashing when /api/auth/me omits the surface field (G4 regression)', async () => {
    // The server OMITS `surface` when the running server hasn't yet reloaded a
    // freshly-minted surface. The page must render the account regardless.
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u) =>
        u.includes('/api/auth/me') ? json({ account: ME_PAYLOAD.account }) : null,
      ),
    );
    renderSettings('/settings/account');
    await waitFor(() => expect(screen.getByTestId('account-id')).toHaveTextContent('acct-123'));
    expect(screen.queryByTestId('surface-id')).toBeNull();
  });

  describe('Deactivate surface', () => {
    let reloadSpy: ReturnType<typeof vi.fn>;
    let origLocation: Location;
    beforeEach(() => {
      reloadSpy = vi.fn();
      origLocation = window.location;
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...origLocation, origin: origLocation.origin, reload: reloadSpy },
      });
    });
    afterEach(() => {
      Object.defineProperty(window, 'location', { configurable: true, value: origLocation });
    });

    it('revokes this surface then clears credential + reloads', async () => {
      const fetchMock = makeFetch();
      vi.stubGlobal('fetch', fetchMock);
      renderSettings('/settings/account');
      // Wait for `me` (which carries the surfaceId it self-revokes) to load
      // before clicking, or the click races ahead and skips the revoke.
      await waitFor(() => expect(screen.getByTestId('account-id')).toHaveTextContent('acct-123'));
      fireEvent.click(screen.getByTestId('deactivate-surface'));
      fireEvent.click(await screen.findByTestId('confirm-ok'));
      await waitFor(() => {
        const revoked = fetchMock.mock.calls.some(
          (c) =>
            String(c[0]).includes('/api/auth/revoke') &&
            String((c[1] as RequestInit | undefined)?.body).includes('web-dev-1'),
        );
        expect(revoked).toBe(true);
      });
      await waitFor(() => expect(reloadSpy).toHaveBeenCalled());
    });

    it('forgets the chat list and transcripts held on this device before it reloads', async () => {
      const { IDBFactory } = await import('fake-indexeddb');
      (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
      const lists = await import('../lib/chatListCache.js');
      const transcripts = await import('../lib/transcriptCache.js');
      lists.__resetChatListCacheForTests();
      transcripts.__resetCacheForTests();
      await lists.saveChatList([{ chatId: 'a', status: 'active', lastUpdated: 1 } as never]);
      await transcripts.saveEvents('a', [
        { type: 'chat.message', chatId: 'a', seq: 1, role: 'user', content: 'x' },
      ]);
      // What the page can see at the moment it reloads: the copy must already be gone.
      let heldAtReload: unknown = 'unset';
      reloadSpy.mockImplementation(() => {
        heldAtReload = 'reloaded';
      });
      vi.stubGlobal('fetch', makeFetch());
      renderSettings('/settings/account');
      await waitFor(() => expect(screen.getByTestId('account-id')).toHaveTextContent('acct-123'));
      fireEvent.click(screen.getByTestId('deactivate-surface'));
      fireEvent.click(await screen.findByTestId('confirm-ok'));
      await waitFor(() => expect(heldAtReload).toBe('reloaded'));
      expect(await lists.loadChatList()).toBeNull();
      expect(await transcripts.loadTranscript('a')).toBeNull();
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
      lists.__resetChatListCacheForTests();
      transcripts.__resetCacheForTests();
    });

    it('a revoke failure still clears the credential and reloads (pushes an error first)', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetch({}, (u) =>
          u.includes('/api/auth/revoke') ? json({ error: 'nope' }, 500) : null,
        ),
      );
      renderSettings('/settings/account');
      await waitFor(() => expect(screen.getByTestId('account-id')).toHaveTextContent('acct-123'));
      fireEvent.click(screen.getByTestId('deactivate-surface'));
      fireEvent.click(await screen.findByTestId('confirm-ok'));
      await waitFor(() => expect(errors().some((e) => /revoke failed/i.test(e))).toBe(true));
      await waitFor(() => expect(reloadSpy).toHaveBeenCalled());
    });

    it('with no surfaceId on `me` skips the self-revoke call entirely', async () => {
      const fetchMock = makeFetch({}, (u) =>
        u.includes('/api/auth/me') ? json({ account: ME_PAYLOAD.account }) : null,
      );
      vi.stubGlobal('fetch', fetchMock);
      renderSettings('/settings/account');
      await waitFor(() => expect(screen.getByTestId('account-id')).toHaveTextContent('acct-123'));
      fireEvent.click(screen.getByTestId('deactivate-surface'));
      fireEvent.click(await screen.findByTestId('confirm-ok'));
      await waitFor(() => expect(reloadSpy).toHaveBeenCalled());
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/auth/revoke'))).toBe(
        false,
      );
    });

    // spec/14 § /settings details → "This surface": destructive, so it warns
    // first, and cancelling must be a complete no-op.
    it('cancelling the warning revokes nothing and does not reload', async () => {
      const fetchMock = makeFetch();
      vi.stubGlobal('fetch', fetchMock);
      renderSettings('/settings/account');
      await waitFor(() => expect(screen.getByTestId('account-id')).toHaveTextContent('acct-123'));
      fireEvent.click(screen.getByTestId('deactivate-surface'));
      // The warning names the consequence: the surface must be paired again.
      const dialog = await screen.findByTestId('confirm-modal');
      expect(dialog.textContent ?? '').toMatch(/pair/i);
      expect(screen.getByTestId('confirm-ok')).toHaveTextContent('Deactivate');
      fireEvent.click(screen.getByTestId('confirm-cancel'));
      await waitFor(() => expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument());
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/auth/revoke'))).toBe(
        false,
      );
      expect(reloadSpy).not.toHaveBeenCalled();
    });

    it('the control is never labelled log out / sign out', async () => {
      vi.stubGlobal('fetch', makeFetch());
      renderSettings('/settings/account');
      await waitFor(() => expect(screen.getByTestId('deactivate-surface')).toBeInTheDocument());
      expect(screen.getByTestId('deactivate-surface')).toHaveTextContent('Deactivate');
      expect(screen.getByTestId('deactivate-surface').textContent ?? '').not.toMatch(
        /log ?out|sign ?out/i,
      );
    });
  });
});

describe('Settings → Devices', () => {
  it('lists linked devices, marks the current one, and revokes another', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderSettings('/settings/devices');
    await waitFor(() => expect(screen.getByTestId('device-web-dev-1')).toBeInTheDocument());
    expect(screen.getByTestId('device-web-dev-1')).toHaveTextContent('This device');
    // current device: no revoke button
    expect(screen.queryByTestId('device-revoke-web-dev-1')).toBeNull();
    // other device: revoke button present
    fireEvent.click(screen.getByTestId('device-revoke-mob-7'));
    await waitFor(() => {
      const called = fetchMock.mock.calls.some(
        (c) =>
          String(c[0]).includes('/api/auth/revoke') &&
          c[1] !== undefined &&
          String((c[1] as RequestInit).body).includes('mob-7'),
      );
      expect(called).toBe(true);
    });
    await waitFor(() => expect(errors()).toContain('Device removed.'));
  });

  it('a failed device revoke surfaces "revoke failed: …"', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u) => (u.includes('/api/auth/revoke') ? json({ error: 'nope' }, 500) : null)),
    );
    renderSettings('/settings/devices');
    await waitFor(() => expect(screen.getByTestId('device-revoke-mob-7')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('device-revoke-mob-7'));
    await waitFor(() => expect(errors().some((e) => /revoke failed/i.test(e))).toBe(true));
  });

  // Push registration belongs to the devices it is about, not to a heading of
  // its own stating a bare number.
  it('states the push count on the phone it belongs to, and offers NO register button', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderSettings('/settings/devices');
    await waitFor(() =>
      expect(screen.getByTestId('device-mob-7')).toHaveTextContent('2 registered for push'),
    );
    expect(screen.getByTestId('device-mob-7')).toHaveTextContent('Android');
    expect(screen.getByTestId('device-web-dev-1')).not.toHaveTextContent('push');
    // Push is an Android-app capability — no dead "Register push" on the web.
    expect(screen.queryByTestId('push-register')).not.toBeInTheDocument();
  });

  it('keeps voice devices out of the linked list — they live under Voice', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({
        devices: [
          ...SETTINGS_PAYLOAD.devices,
          {
            surfaceId: 'vd-1',
            surfaceKind: 'voice-device',
            label: 'kitchen',
            issuedAt: 4,
            status: 'online',
            lastHeartbeat: 1,
            isCurrent: false,
          },
        ],
      }),
    );
    renderSettings('/settings/devices');
    await waitFor(() => expect(screen.getByTestId('device-mob-7')).toBeInTheDocument());
    expect(screen.queryByTestId('device-vd-1')).toBeNull();
  });

  it('shows "No linked surfaces." when the device list is empty', async () => {
    vi.stubGlobal('fetch', makeFetch({ devices: [] }));
    renderSettings('/settings/devices');
    await waitFor(() => expect(screen.getByText('No linked surfaces.')).toBeInTheDocument());
  });

  it('shows transient loading placeholders before /api/settings resolves', async () => {
    let resolveSettings: ((r: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u, init) =>
        u.includes('/api/settings') && (init?.method ?? 'GET') === 'GET'
          ? (new Promise<Response>((resolve) => {
              resolveSettings = resolve;
            }) as unknown as Response)
          : null,
      ),
    );
    renderSettings('/settings/devices');
    await waitFor(() => expect(screen.getByText('Loading…')).toBeInTheDocument());
    resolveSettings?.(json(SETTINGS_PAYLOAD));
    await waitFor(() => expect(screen.getByTestId('device-mob-7')).toBeInTheDocument());
  });

  it('mints no pairing code until "Link a device" is pressed, then shows it', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderSettings('/settings/devices');
    await waitFor(() => expect(screen.getByTestId('device-mob-7')).toBeInTheDocument());
    const minted = (): boolean =>
      fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/auth/pair/start'));
    expect(minted()).toBe(false);
    expect(screen.queryByTestId('link-device')).toBeNull();
    fireEvent.click(screen.getByTestId('link-device-open'));
    await waitFor(() =>
      expect(screen.getByTestId('link-device-nonce')).toHaveTextContent('NONCE-abc123def456'),
    );
    expect(minted()).toBe(true);
    expect(screen.getByTestId('link-device-open')).toBeDisabled();
    fireEvent.click(screen.getByTestId('link-device-close'));
    await waitFor(() => expect(screen.queryByTestId('link-device')).toBeNull());
    expect(screen.getByTestId('link-device-open')).not.toBeDisabled();
  });
});

describe('Settings → Dictation and Voice', () => {
  describe('Dictate shortcut', () => {
    beforeEach(() => {
      localStorage.clear();
      useUiStore.setState({ dictateChord: DEFAULT_DICTATE_CHORD });
    });

    it('shows ⌘⇧D until changed (Ctrl+Shift+D off a Mac, as jsdom is)', async () => {
      vi.stubGlobal('fetch', makeFetch());
      renderSettings('/settings/dictation');
      expect(await screen.findByTestId('dictate-chord')).toHaveTextContent('Ctrl+Shift+D');
    });

    it('Change records the next chord with ⌘ in it, and keeps it for this host', async () => {
      vi.stubGlobal('fetch', makeFetch());
      renderSettings('/settings/dictation');
      fireEvent.click(await screen.findByTestId('dictate-chord-change'));
      expect(screen.getByTestId('dictate-chord')).toHaveTextContent('Press keys…');
      // A key with no ⌘ is not a chord: still listening.
      fireEvent.keyDown(window, { key: 'm', code: 'KeyM' });
      expect(screen.getByTestId('dictate-chord')).toHaveTextContent('Press keys…');
      // Nor is ⌘ on its own.
      fireEvent.keyDown(window, { key: 'Meta', code: 'MetaLeft', metaKey: true });
      expect(screen.getByTestId('dictate-chord')).toHaveTextContent('Press keys…');
      fireEvent.keyDown(window, { key: 'µ', code: 'KeyM', metaKey: true, altKey: true });
      expect(screen.getByTestId('dictate-chord')).toHaveTextContent('Ctrl+Alt+M');
      expect(useUiStore.getState().dictateChord).toEqual({ alt: true, shift: false, code: 'KeyM' });
      expect(JSON.parse(localStorage.getItem('patch.voice.dictateChord')!)).toEqual({
        alt: true,
        shift: false,
        code: 'KeyM',
      });
    });

    it('Esc leaves the old chord', async () => {
      vi.stubGlobal('fetch', makeFetch());
      renderSettings('/settings/dictation');
      fireEvent.click(await screen.findByTestId('dictate-chord-change'));
      fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
      expect(screen.getByTestId('dictate-chord')).toHaveTextContent('Ctrl+Shift+D');
      expect(useUiStore.getState().dictateChord).toEqual(DEFAULT_DICTATE_CHORD);
    });
  });

  // spec/07 § Voice — a config matrix: a hosted cell whose key a host lacks is
  // shown as not configured on that host, from `host.host.voiceKeys`.
  describe('a backend with no key on a host', () => {
    it('names the missing key per host on a device and on the voice provider', async () => {
      usePreferencesStore.setState({
        preferences: {
          ...usePreferencesStore.getState().preferences,
          voiceConfig: {
            speechToText: 'groq',
            dictation: { phone: 'deepgram', computer: 'whisper', tidy: false },
            meeting: 'local',
            deviceAnswer: 'agent',
          },
          voiceAgent: {
            ...usePreferencesStore.getState().preferences.voiceAgent,
            provider: 'openai',
          },
        },
        loaded: true,
      });
      vi.stubGlobal('fetch', makeFetch());
      reportHost('d1', {
        hostName: 'hetzner',
        voiceKeys: { gemini: false, openai: false, deepgram: false },
      });
      reportHost('d2', {
        hostName: 'mac',
        runsManager: false,
        voiceKeys: { gemini: true, openai: false, deepgram: true },
      });
      reportHost('d3', { hostName: 'old-daemon', runsManager: false });
      renderSettings('/settings/dictation');
      await waitFor(() => expect(screen.getByTestId('dictation-mob-7-keys')).toBeInTheDocument());
      expect(screen.getByTestId('dictation-mob-7-keys')).toHaveTextContent(
        'Not configured on hetzner: no Deepgram key is set. Sessions there are refused.',
      );
      // Whisper on this browser needs no key.
      expect(screen.queryByTestId('dictation-web-dev-1-keys')).toBeNull();
      fireEvent.click(screen.getByTestId('settings-nav-voice'));
      await waitFor(() => expect(screen.getByTestId('voice-keys')).toBeInTheDocument());
      expect(screen.getByTestId('voice-keys')).toHaveTextContent(
        'Not configured on hetzner, mac: no OpenAI key is set. Sessions there are refused.',
      );
    });

    // spec/02 § Provider keys: a key set from Settings → Providers takes effect with
    // no restart, and the host's next report is what clears the line.
    it('clears the line live when the host reports the key has been set', async () => {
      usePreferencesStore.setState({
        preferences: {
          ...usePreferencesStore.getState().preferences,
          voiceConfig: {
            speechToText: 'groq',
            dictation: { phone: 'whisper', computer: 'deepgram', tidy: false },
            meeting: 'local',
            deviceAnswer: 'direct',
          },
        },
        loaded: true,
      });
      vi.stubGlobal('fetch', makeFetch());
      reportHost('d1', {
        hostName: 'hetzner',
        voiceKeys: { gemini: false, openai: false, deepgram: false },
      });
      renderSettings('/settings/dictation');
      await waitFor(() =>
        expect(screen.getByTestId('dictation-web-dev-1-keys')).toBeInTheDocument(),
      );
      act(() =>
        reportHost('d1', {
          hostName: 'hetzner',
          voiceKeys: { gemini: false, openai: false, deepgram: true },
        }),
      );
      await waitFor(() => expect(screen.queryByTestId('dictation-web-dev-1-keys')).toBeNull());
    });
  });

  describe('Dictation engines, one per device', () => {
    it('lists every device at once, each with only the engines it can run', async () => {
      vi.stubGlobal('fetch', makeFetch());
      renderSettings('/settings/dictation');
      expect(await screen.findByTestId('dictation-device-mob-7-engine-device')).toHaveTextContent(
        'Built-in',
      );
      expect(screen.getByTestId('dictation-device-web-dev-1')).toHaveTextContent('This device');
      // A browser has no recogniser of its own and cannot carry Parakeet.
      expect(screen.queryByTestId('dictation-device-web-dev-1-engine-device')).toBeNull();
      expect(screen.queryByTestId('dictation-device-web-dev-1-engine-local')).toBeNull();
      expect(screen.getByTestId('dictation-device-mob-7-engine-device')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByTestId('dictation-device-web-dev-1-engine-whisper')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('a change writes that device’s own engine and nothing else', async () => {
      const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      renderSettings('/settings/dictation');
      fireEvent.click(await screen.findByTestId('dictation-device-mob-7-engine-deepgram'));
      await waitFor(() =>
        expect(server.writes).toContainEqual({ deviceDictation: { 'mob-7': 'deepgram' } }),
      );
    });

    it('speech to text: choosing an engine writes it', async () => {
      const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      renderSettings('/settings/dictation');
      expect(await screen.findByTestId('stt-engine-groq')).toHaveTextContent('Groq Whisper');
      fireEvent.click(screen.getByTestId('stt-engine-parakeet'));
      await waitFor(() => expect(server.writes).toHaveLength(1));
      expect((server.writes[0]!.voiceConfig as Record<string, unknown>).speechToText).toBe(
        'parakeet',
      );
    });

    it('tidy-up is one switch for every device', async () => {
      const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      renderSettings('/settings/dictation');
      fireEvent.click(await screen.findByTestId('dictation-tidy-toggle'));
      await waitFor(() => expect(server.writes).toHaveLength(1));
      expect((server.writes[0]!.voiceConfig as Record<string, unknown>).dictation).toEqual({
        phone: 'device',
        computer: 'whisper',
        tidy: true,
      });
    });
  });

  it('Meetings: the transcription engine is chosen on its own page, and a missing key is named', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    reportHost('d1', {
      hostName: 'hetzner',
      voiceKeys: { gemini: false, openai: false, assemblyai: false },
    });
    renderSettings('/settings/meetings');
    expect(await screen.findByTestId('meeting-engine-pills-local')).toHaveTextContent(
      'Parakeet (free, on device)',
    );
    expect(screen.queryByTestId('meeting-engine-keys')).toBeNull();
    fireEvent.click(screen.getByTestId('meeting-engine-pills-assemblyai'));
    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect((server.writes[0]!.voiceConfig as Record<string, unknown>).meeting).toBe('assemblyai');
    await waitFor(() =>
      expect(screen.getByTestId('meeting-engine-keys')).toHaveTextContent(
        'Not configured on hetzner: no AssemblyAI key is set.',
      ),
    );
  });

  describe('Voice calls', () => {
    it('a failed write is said', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetch({}, (u, init) =>
          u.includes('/api/settings') && init?.method === 'PATCH'
            ? json({ error: 'nope' }, 500)
            : null,
        ),
      );
      renderSettings('/settings/voice');
      fireEvent.click(await screen.findByTestId('voice-agent-provider-openai'));
      await waitFor(() => expect(errors().some((e) => e.startsWith('voice agent:'))).toBe(true));
    });

    it('shows usage in tokens and credits, summed across hosts, with the plan', async () => {
      vi.stubGlobal('fetch', makeFetch());
      reportHost('d1', {
        hostName: 'hetzner',
        voiceUsage: {
          monthUsd: 1,
          monthCalls: 2,
          allUsd: 2,
          allCalls: 5,
          monthTokens: 1000,
          allTokens: 3000,
          monthCredits: 2000,
          allCredits: 4000,
          elevenLabsPlan: { used: 41304, limit: 185575 },
        },
      });
      reportHost('d2', {
        hostName: 'mac',
        runsManager: false,
        voiceUsage: { monthUsd: 0, monthCalls: 1, allUsd: 0, allCalls: 1, monthTokens: 500 },
      });
      renderSettings('/settings/voice');
      expect(await screen.findByTestId('voice-usage-month')).toHaveTextContent(
        '3 calls · 1,500 tokens · 2,000 ElevenLabs credits',
      );
      expect(screen.getByTestId('voice-usage-plan')).toHaveTextContent(
        '41,304 of 185,575 credits used',
      );
      expect(screen.getByTestId('settings-voice')).not.toHaveTextContent('$');
    });
  });

  it('the voice instructions are editable, starting from the default', async () => {
    renderSettings('/settings/voice');
    const row = await screen.findByTestId('prompt-voice-instructions');
    expect(row).toHaveTextContent('Voice instructions');
    // Default until the user writes their own.
    expect(screen.getByTestId('prompt-voice-instructions-mode')).toHaveTextContent('Default');
    expect(screen.queryByTestId('prompt-voice-instructions-edit')).toBeNull();
  });

  it('Dictation mode: shows the pause and writes the chosen one', async () => {
    const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    loadShared();
    renderSettings('/settings/dictation');
    const pills = await screen.findByTestId('dictation-pause');
    expect(pills.querySelector('[aria-pressed="true"]')).toHaveTextContent('10s');
    fireEvent.click(within(pills).getByText('5s'));
    await waitFor(() => expect(server.writes).toContainEqual({ dictationPauseSeconds: 5 }));
  });

  it('Dictation mode: turn detection is on by default and can be turned off', async () => {
    const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    loadShared();
    renderSettings('/settings/dictation');
    const toggle = await screen.findByTestId('dictation-turn-detection-toggle');
    expect(screen.getByTestId('settings-voice-dictation')).toHaveTextContent(
      'Send anyway after a pause of',
    );
    fireEvent.click(toggle);
    await waitFor(() => expect(server.writes).toContainEqual({ dictationTurnDetection: false }));
  });

  describe('Voice devices answering directly (speech on the host)', () => {
    it('writes the chosen Kokoro voice to the account', async () => {
      const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      loadShared({ settings: { kokoroVoice: 'af_heart' } });
      renderSettings('/settings/voice');
      const select = (await screen.findByTestId('kokoro-voice')) as HTMLSelectElement;
      expect(select.value).toBe('af_heart');
      fireEvent.change(select, { target: { value: 'bm_george' } });
      await waitFor(() => expect(server.writes).toContainEqual({ kokoroVoice: 'bm_george' }));
    });

    it('chooses ElevenLabs to read replies and writes it to the account', async () => {
      const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      loadShared();
      renderSettings('/settings/voice');
      await screen.findByTestId('kokoro-voice');
      fireEvent.click(within(screen.getByTestId('tts-backend')).getByText('ElevenLabs'));
      await waitFor(() => expect(server.writes).toContainEqual({ ttsBackend: 'elevenlabs' }));
    });

    it('with ElevenLabs chosen and no key on any host, says why there are no voices', async () => {
      vi.stubGlobal('fetch', makeFetch());
      loadShared({ settings: { ttsBackend: 'elevenlabs' } });
      renderSettings('/settings/voice');
      const select = (await screen.findByTestId('elevenlabs-voice')) as HTMLSelectElement;
      expect(select.disabled).toBe(true);
      expect(screen.getByTestId('settings-voice-devices')).toHaveTextContent(
        'Add an ElevenLabs key',
      );
    });

    it('chooses an ElevenLabs model and writes it to the account', async () => {
      const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      loadShared({ settings: { ttsBackend: 'elevenlabs' } });
      renderSettings('/settings/voice');
      const select = await screen.findByTestId('elevenlabs-model');
      fireEvent.change(select, { target: { value: 'eleven_v3' } });
      await waitFor(() => expect(server.writes).toContainEqual({ elevenLabsModel: 'eleven_v3' }));
    });

    it('says each host uses its own default until a voice is chosen', async () => {
      vi.stubGlobal('fetch', makeFetch());
      loadShared();
      renderSettings('/settings/voice');
      const select = (await screen.findByTestId('kokoro-voice')) as HTMLSelectElement;
      expect(select.value).toBe('');
      expect(screen.getByTestId('settings-voice-devices')).toHaveTextContent(
        'Each host’s Kokoro default',
      );
    });

    it('has no chat title setting: a title is set once', async () => {
      vi.stubGlobal('fetch', makeFetch());
      loadShared();
      renderSettings('/settings/voice');
      await screen.findByTestId('settings-voice-devices');
      expect(screen.queryByTestId('chat-name-interval')).toBeNull();
    });
  });

  describe('Voice devices', () => {
    const withVoiceDevice = {
      devices: [
        ...SETTINGS_PAYLOAD.devices,
        {
          surfaceId: 'vd-1',
          surfaceKind: 'voice-device',
          label: 'kitchen',
          issuedAt: 4,
          status: 'online',
          lastHeartbeat: 1,
          isCurrent: false,
        },
      ],
    };

    it('says none are set up, and creates a token only when asked', async () => {
      const fetchMock = makeFetch();
      vi.stubGlobal('fetch', fetchMock);
      renderSettings('/settings/voice');
      await waitFor(() => expect(screen.getByTestId('voice-devices-empty')).toBeInTheDocument());
      // Linked phones and browsers are not voice devices.
      expect(screen.queryByTestId('device-mob-7')).toBeNull();
      const created = (): boolean =>
        fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/voice-devices'));
      fireEvent.click(screen.getByTestId('voice-device-add-open'));
      expect(screen.getByTestId('voice-device-add-submit')).toBeDisabled();
      fireEvent.change(screen.getByTestId('voice-device-label'), { target: { value: 'Kitchen' } });
      expect(created()).toBe(false);
      fireEvent.click(screen.getByTestId('voice-device-add-submit'));
      await waitFor(() =>
        expect(screen.getByTestId('voice-device-token')).toHaveTextContent('DEVICE-TOKEN-xyz'),
      );
      expect(created()).toBe(true);
      expect(screen.queryByTestId('voice-device-add-open')).toBeNull();
      fireEvent.click(screen.getByTestId('voice-device-add-close'));
      await waitFor(() => expect(screen.queryByTestId('voice-device-add-panel')).toBeNull());
      expect(screen.getByTestId('voice-device-add-open')).toBeInTheDocument();
    });

    it('lists voice devices, each revocable, with Add another', async () => {
      const fetchMock = makeFetch(withVoiceDevice);
      vi.stubGlobal('fetch', fetchMock);
      renderSettings('/settings/voice');
      await waitFor(() => expect(screen.getByTestId('device-vd-1')).toHaveTextContent('kitchen'));
      expect(screen.getByTestId('device-vd-1')).toHaveTextContent('Voice device');
      expect(screen.getByTestId('voice-device-add-open')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('device-revoke-vd-1'));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            (c) =>
              String(c[0]).includes('/api/auth/revoke') &&
              String((c[1] as RequestInit).body).includes('vd-1'),
          ),
        ).toBe(true),
      );
    });
  });
});

describe('Settings → Agent', () => {
  describe('Model for new chats (account-wide)', () => {
    it('offers the default host’s catalogue and writes the pick to the account', async () => {
      const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
      vi.stubGlobal(
        'fetch',
        makeFetch({}, (u, init) =>
          u.includes('/api/models')
            ? json({
                models: [
                  { id: 'claude-opus-5', label: 'Opus 5' },
                  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
                ],
              })
            : server.handler(u, init),
        ),
      );
      reportHost('d1', { hostName: 'mac' });
      renderSettings('/settings/agent');
      await waitFor(() =>
        expect(screen.getByRole('option', { name: 'Sonnet 5' })).toBeInTheDocument(),
      );
      fireEvent.change(screen.getByTestId('default-model'), {
        target: { value: 'claude-sonnet-5' },
      });
      await waitFor(() => expect(server.writes).toEqual([{ defaultModel: 'claude-sonnet-5' }]));
    });

    it('says the list is unavailable with no host attached, keeping the saved value', async () => {
      vi.stubGlobal('fetch', makeFetch());
      clearHosts();
      renderSettings('/settings/agent');
      await waitFor(() =>
        expect(screen.getByTestId('default-model-no-host')).toHaveTextContent(
          'isn’t available yet',
        ),
      );
      expect((screen.getByTestId('default-model') as HTMLSelectElement).value).toBe(
        usePreferencesStore.getState().preferences.defaultModel,
      );
    });
  });

  // spec/02 § Permission mode. The host default was reachable only from the
  // CLI: the settings page never named it, so the mode the next chat would be
  // stamped with was invisible from every surface.
  describe('Default permission mode (shared)', () => {
    it('shows the account’s default and writes a change to the server', async () => {
      const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      loadShared({ settings: { permissionModeDefault: 'acceptEdits' } });
      renderSettings('/settings/agent');
      const select = (await screen.findByTestId('permission-default')) as HTMLSelectElement;
      expect(select.value).toBe('acceptEdits');
      // The SDK's own mode names, never reworded, in the composer's order.
      expect(Array.from(select.options).map((o) => o.value)).toEqual([...PERMISSION_MODES]);
      fireEvent.change(select, { target: { value: 'bypassPermissions' } });
      await waitFor(() =>
        expect(server.writes).toContainEqual({ permissionModeDefault: 'bypassPermissions' }),
      );
    });

    it('sets a default for Codex among only the modes it can run', async () => {
      const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      loadShared({ settings: { permissionModeDefault: 'auto' } });
      renderSettings('/settings/agent');
      const select = (await screen.findByTestId('permission-default-codex')) as HTMLSelectElement;
      // Codex cannot run `auto`, so it shows what a new Codex chat gets.
      expect(select.value).toBe('default');
      expect(Array.from(select.options).map((o) => o.value)).not.toContain('auto');
      fireEvent.change(select, { target: { value: 'bypassPermissions' } });
      await waitFor(() =>
        expect(server.writes).toContainEqual({
          providerPermissionDefaults: { codex: 'bypassPermissions' },
        }),
      );
    });

    it('does not depend on any host being online', async () => {
      vi.stubGlobal('fetch', makeFetch());
      loadShared();
      reportHost('d1');
      usePresenceStore.getState().setHostOnline('d1', false);
      renderSettings('/settings/agent');
      await waitFor(() => expect(screen.getByTestId('permission-default')).not.toBeDisabled());
    });
  });

  describe('Added to Claude Code (shared)', () => {
    // principles.md § No system-prompt injection — the built-in tools
    // guidance is shown, not hidden, while it is in force.
    it('shows the built-in tools guidance when there is no override, marked Default', async () => {
      vi.stubGlobal('fetch', makeFetch());
      loadShared();
      reportHost('d1', {
        harnessToolsPromptDefault: '# Patch tools\n\nUse view_file to show a file.',
      });
      renderSettings('/settings/agent');
      await waitFor(() =>
        expect(screen.getByTestId('prompt-tools-shown')).toHaveTextContent('Use view_file'),
      );
      expect(screen.getByTestId('prompt-tools-mode-default')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('an edited tools guidance shows the edit, and Default restores the built-in one', async () => {
      const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      loadShared({ settings: { harnessToolsPrompt: 'my own guidance' } });
      reportHost('d1', { harnessToolsPromptDefault: '# Patch tools' });
      renderSettings('/settings/agent');
      await waitFor(() =>
        expect(screen.getByTestId('prompt-tools-shown')).toHaveTextContent('my own guidance'),
      );
      fireEvent.click(screen.getByTestId('prompt-tools-mode-default'));
      await waitFor(() => expect(server.writes).toContainEqual({ harnessToolsPrompt: null }));
    });

    it('an emptied tools guidance reads as Off', async () => {
      vi.stubGlobal('fetch', makeFetch());
      loadShared({ settings: { harnessToolsPrompt: '' } });
      reportHost('d1', { harnessToolsPromptDefault: '# Patch tools' });
      renderSettings('/settings/agent');
      await waitFor(() =>
        expect(screen.getByTestId('prompt-tools-shown')).toHaveTextContent(/^Off/),
      );
    });

    it('Save writes the system prompt and closes the editor', async () => {
      const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      loadShared({ settings: { harnessSystemPrompt: 'Be terse.\nAlways.' } });
      renderSettings('/settings/agent');
      await waitFor(() =>
        expect(screen.getByTestId('prompt-system-shown')).toHaveTextContent('Be terse.'),
      );
      fireEvent.click(screen.getByTestId('prompt-system-edit'));
      const box = screen.getByTestId('prompt-system-text') as HTMLTextAreaElement;
      expect(box.value).toBe('Be terse.\nAlways.');
      fireEvent.change(box, { target: { value: 'Be kind.' } });
      fireEvent.click(screen.getByTestId('prompt-system-save'));
      await waitFor(() =>
        expect(server.writes).toContainEqual({ harnessSystemPrompt: 'Be kind.' }),
      );
      await waitFor(() => expect(screen.queryByTestId('prompt-system-text')).toBeNull());
    });
  });

  // The CLAUDE.md toggle, the Skills field, the Browser tools toggle and the
  // Project folders editor were removed with the redesign: CLAUDE.md is always
  // loaded, skills are the SDK's own, browser tools are two MCP servers (MCP
  // page), and the folder picker browses anywhere. None may creep back.
  describe('removed controls', () => {
    it('offers no CLAUDE.md, Skills, Browser tools or Project folders control', async () => {
      vi.stubGlobal('fetch', makeFetch());
      reportHost('d1', {
        harnessClaudeMdEnabled: true,
        harnessBrowserToolsEnabled: true,
        harnessSkills: 'all',
      });
      const { container } = renderSettings('/settings/agent');
      await waitFor(() => expect(screen.getByTestId('harness-config')).toBeInTheDocument());
      for (const id of [
        'harness-claude-md-enabled',
        'harness-skills',
        'harness-browser-tools-enabled',
        'settings-agent-behavior',
      ]) {
        expect(screen.queryByTestId(id)).toBeNull();
      }
      const text = container.textContent ?? '';
      expect(text).not.toMatch(/CLAUDE\.md|Skills|Browser tools|Project folders/);
    });

    it('draws no old single-page group anywhere in the nav or index', async () => {
      vi.stubGlobal('fetch', makeFetch());
      reportHost('d1');
      const { container } = renderSettings('/settings');
      await waitFor(() => expect(screen.getByTestId('settings-usage')).toBeInTheDocument());
      const headings = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent);
      for (const gone of [
        'Agent behavior',
        'Credit sources',
        'Hosts & devices',
        'Integrations',
        'Special threads',
        'Connection',
        'This surface',
        'Daemons',
      ]) {
        expect(headings).not.toContain(gone);
      }
    });
  });

  describe('Questions — auto-expiry toggle and window (spec/02 § Questions are not approvals)', () => {
    const TOGGLE = 'question-expiry-toggle';
    const SECONDS = 'question-expiry-seconds';

    it('shows both controls reflecting the shared settings', async () => {
      vi.stubGlobal('fetch', makeFetch());
      loadShared({ settings: { questionExpiry: true, questionExpirySeconds: 60 } });
      renderSettings('/settings/agent');
      await waitFor(() => expect(screen.getByTestId(TOGGLE)).toBeInTheDocument());
      expect((screen.getByTestId(TOGGLE) as HTMLInputElement).checked).toBe(true);
      expect((screen.getByTestId(SECONDS) as HTMLInputElement).value).toBe('60');
    });

    it('turning it off writes questionExpiry:false', async () => {
      const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      loadShared({ settings: { questionExpiry: true } });
      renderSettings('/settings/agent');
      fireEvent.click(await screen.findByTestId(TOGGLE));
      await waitFor(() => expect(server.writes).toContainEqual({ questionExpiry: false }));
    });

    it('writes a window in bounds, and refuses one outside them without writing', async () => {
      const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      loadShared({ settings: { questionExpirySeconds: 600 } });
      renderSettings('/settings/agent');
      const input = (await screen.findByTestId(SECONDS)) as HTMLInputElement;
      fireEvent.change(input, { target: { value: '4' } });
      fireEvent.blur(input);
      await waitFor(() => expect(errors().some((e) => /between 5 and 3600/.test(e))).toBe(true));
      expect(server.writes).toEqual([]);
      fireEvent.change(screen.getByTestId(SECONDS), { target: { value: '120' } });
      fireEvent.keyDown(screen.getByTestId(SECONDS), { key: 'Enter' });
      await waitFor(() => expect(server.writes).toContainEqual({ questionExpirySeconds: 120 }));
    });
  });

  describe('Chats (account-wide)', () => {
    it('shows the loaded provider-context level and writes the next one', async () => {
      usePreferencesStore.setState({
        preferences: {
          ...usePreferencesStore.getState().preferences,
          providerContextVerbosity: 'summary',
        },
        loaded: true,
      });
      const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      renderSettings('/settings/agent');
      await waitFor(() => expect(screen.getByTestId('settings-transcript')).toBeInTheDocument());
      expect(screen.getByTestId('provider-context-verbosity-summary')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      fireEvent.click(screen.getByTestId('provider-context-verbosity-full'));
      await waitFor(() =>
        expect(server.writes).toContainEqual({ providerContextVerbosity: 'full' }),
      );
      await waitFor(() =>
        expect(screen.getByTestId('provider-context-verbosity-full')).toHaveAttribute(
          'aria-pressed',
          'true',
        ),
      );
    });

    it('starts at Off when the account preference is off', async () => {
      usePreferencesStore.setState({
        preferences: {
          ...usePreferencesStore.getState().preferences,
          providerContextVerbosity: 'off',
        },
        loaded: true,
      });
      vi.stubGlobal('fetch', makeFetch());
      renderSettings('/settings/agent');
      await waitFor(() =>
        expect(screen.getByTestId('provider-context-verbosity-off')).toHaveAttribute(
          'aria-pressed',
          'true',
        ),
      );
      expect(screen.getByTestId('provider-context-verbosity-summary')).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    it('is disabled until the account preferences have loaded', async () => {
      usePreferencesStore.setState({ loaded: false });
      vi.stubGlobal('fetch', makeFetch());
      renderSettings('/settings/agent');
      await waitFor(() =>
        expect(screen.getByTestId('provider-context-verbosity-full')).toBeDisabled(),
      );
      expect(screen.queryByTestId('provider-switch-warning')).toBeNull();
    });

    // spec/12 § Continue — off by default; turning it on is one preference write.
    it('the automatic-continue toggle is off by default and writes autoContinueInterrupted', async () => {
      const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      renderSettings('/settings/agent');
      const toggle = (await screen.findByTestId('auto-continue-interrupted')) as HTMLInputElement;
      expect(toggle.checked).toBe(false);
      fireEvent.click(toggle);
      await waitFor(() => expect(server.writes).toEqual([{ autoContinueInterrupted: true }]));
    });
  });
});

describe('Settings → Goals (account-wide)', () => {
  it('shows the built-in judge prompt, saves an edit, edits it again, and Default restores it', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    renderSettings('/settings/goals');
    fireEvent.click(await screen.findByTestId('prompt-goal-judge-mode-custom'));
    const box = screen.getByTestId('prompt-goal-judge-text') as HTMLTextAreaElement;
    expect(box.value).toBe(DEFAULT_GOAL_EVAL_PROMPT);
    fireEvent.change(box, { target: { value: 'Judge harshly.' } });
    fireEvent.click(screen.getByTestId('prompt-goal-judge-save'));
    await waitFor(() => expect(server.writes).toEqual([{ goalEvalPrompt: 'Judge harshly.' }]));
    // A custom prompt can be opened again.
    fireEvent.click(await screen.findByTestId('prompt-goal-judge-edit'));
    expect((screen.getByTestId('prompt-goal-judge-text') as HTMLTextAreaElement).value).toBe(
      'Judge harshly.',
    );
    fireEvent.click(screen.getByTestId('prompt-goal-judge-cancel'));
    fireEvent.click(screen.getByTestId('prompt-goal-judge-mode-default'));
    await waitFor(() =>
      expect(server.writes[1]).toEqual({ goalEvalPrompt: DEFAULT_GOAL_EVAL_PROMPT }),
    );
  });

  it('writes the refusal limit, and ignores a value that is not a positive whole number', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    renderSettings('/settings/goals');
    const input = (await screen.findByTestId('goal-refusal-limit')) as HTMLInputElement;
    expect(input.value).toBe('3');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.change(input, { target: { value: '2.5' } });
    fireEvent.change(input, { target: { value: '5' } });
    await waitFor(() => expect(server.writes).toEqual([{ goalRefusalLimit: 5 }]));
  });

  it('shows the stringency as 2 by default and writes the one picked', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    renderSettings('/settings/goals');
    const select = (await screen.findByTestId('goal-stringency')) as HTMLSelectElement;
    expect(select.value).toBe('2');
    fireEvent.change(select, { target: { value: '3' } });
    await waitFor(() => expect(server.writes).toEqual([{ goalStringency: 3 }]));
  });

  it('shows Sonnet 5.5 as the judge model, kept as an option', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    renderSettings('/settings/goals');
    const select = (await screen.findByTestId('goal-model')) as HTMLSelectElement;
    expect(select.value).toBe('claude-sonnet-5-5');
    expect([...select.options].map((o) => o.value)).toContain('claude-sonnet-5-5');
  });
});

describe('Settings → Manager (account-wide)', () => {
  it('writes each control to the account', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    renderSettings('/settings/manager');
    fireEvent.click(await screen.findByTestId('manager-wake-mode-batched'));
    await waitFor(() => expect(server.writes).toHaveLength(1));
    fireEvent.change(screen.getByTestId('manager-quiet-start'), { target: { value: '22:30' } });
    await waitFor(() => expect(server.writes).toHaveLength(2));
    fireEvent.change(screen.getByTestId('manager-quiet-end'), { target: { value: '06:15' } });
    await waitFor(() => expect(server.writes).toHaveLength(3));
    fireEvent.click(screen.getByTestId('rotation-enabled'));
    await waitFor(() => expect(server.writes).toHaveLength(4));
    fireEvent.change(screen.getByTestId('rotation-time'), { target: { value: '03:00' } });
    await waitFor(() => expect(server.writes).toHaveLength(5));
    expect(server.writes).toEqual([
      { managerWake: 'batched' },
      { quietHoursStart: '22:30' },
      { quietHoursEnd: '06:15' },
      { rotationEnabled: false },
      { rotationTime: '03:00' },
    ]);
  });

  it('writes a trimmed address word on blur, and restores an empty one', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    renderSettings('/settings/manager');
    const input = (await screen.findByTestId('manager-address-word')) as HTMLInputElement;
    expect(input.value).toBe('patch');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(input.value).toBe('patch');
    fireEvent.change(input, { target: { value: '  jeeves ' } });
    fireEvent.blur(input);
    await waitFor(() => expect(server.writes).toEqual([{ addressWord: 'jeeves' }]));
  });

  it('Manager prompt: edits it, and Default restores the built-in one', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    renderSettings('/settings/manager');
    fireEvent.click(await screen.findByTestId('prompt-manager-mode-custom'));
    const box = screen.getByTestId('prompt-manager-text') as HTMLTextAreaElement;
    expect(box.value).toBe(DEFAULT_MANAGER_PROMPT);
    fireEvent.change(box, { target: { value: 'Be extra terse.' } });
    fireEvent.click(screen.getByTestId('prompt-manager-save'));
    await waitFor(() => expect(server.writes).toEqual([{ managerPrompt: 'Be extra terse.' }]));
    fireEvent.click(await screen.findByTestId('prompt-manager-mode-default'));
    await waitFor(() =>
      expect(server.writes[1]).toEqual({ managerPrompt: DEFAULT_MANAGER_PROMPT }),
    );
  });

  it('finished chats: Every is only usable when Batched, and writes the interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
      vi.stubGlobal('fetch', makeFetch({}, server.handler));
      renderSettings('/settings/manager');
      const slider = (await screen.findByTestId('manager-wake-interval')) as HTMLInputElement;
      expect(screen.getByTestId('manager-wake-mode-off').getAttribute('aria-pressed')).toBe('true');
      expect(slider.disabled).toBe(true);
      fireEvent.click(screen.getByTestId('manager-wake-mode-batched'));
      await waitFor(() => expect(slider.disabled).toBe(false));
      fireEvent.change(slider, { target: { value: '3' } });
      await vi.advanceTimersByTimeAsync(400);
      await waitFor(() =>
        expect(server.writes).toEqual([
          { managerWake: 'batched' },
          { managerWakeIntervalMinutes: 60 },
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('Context: the window says how many are kept, and This session says what the host reported', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u, init) =>
        u.endsWith('/api/chats/thread_manager')
          ? json({ chatId: 'thread_manager', session: { messages: 34, startedAt: Date.now() } })
          : server.handler(u, init),
      ),
    );
    renderSettings('/settings/manager');
    expect((await screen.findByTestId('manager-context-window-unit')).textContent).toBe(
      'messages, keeping the last 40',
    );
    await waitFor(() =>
      expect(screen.getByTestId('manager-session').textContent).toMatch(
        /34 messages · started today \d\d:\d\d/,
      ),
    );
  });

  it('link summary prompt: edits it on the Agent page, and Default restores the built-in one', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    renderSettings('/settings/agent');
    fireEvent.click(await screen.findByTestId('prompt-link-summary-mode-custom'));
    const box = screen.getByTestId('prompt-link-summary-text') as HTMLTextAreaElement;
    expect(box.value).toBe(DEFAULT_LINK_SUMMARY_PROMPT);
    fireEvent.change(box, { target: { value: 'One line only.' } });
    fireEvent.click(screen.getByTestId('prompt-link-summary-save'));
    await waitFor(() => expect(server.writes).toEqual([{ linkSummaryPrompt: 'One line only.' }]));
    fireEvent.click(await screen.findByTestId('prompt-link-summary-mode-default'));
    await waitFor(() =>
      expect(server.writes[1]).toEqual({ linkSummaryPrompt: DEFAULT_LINK_SUMMARY_PROMPT }),
    );
  });

  it('keeps the saved special-thread model as an option and writes a new pick', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u, init) =>
        u.includes('/api/models')
          ? json({ models: [{ id: 'claude-opus-5', label: 'Opus 5' }] })
          : server.handler(u, init),
      ),
    );
    reportHost('d1');
    renderSettings('/settings/manager');
    const select = (await screen.findByTestId('special-thread-model')) as HTMLSelectElement;
    await waitFor(() =>
      expect(within(select).getByRole('option', { name: 'Opus 5' })).toBeInTheDocument(),
    );
    // The saved value is not in the host's list, and is still offered.
    expect(select.value).toBe('claude-sonnet-5');
    fireEvent.change(select, { target: { value: 'claude-opus-5' } });
    await waitFor(() => expect(server.writes).toEqual([{ specialThreadModel: 'claude-opus-5' }]));
  });
});
