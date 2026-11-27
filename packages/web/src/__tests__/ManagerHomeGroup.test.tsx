// Settings → Manager → Home (spec/06 § Changing home): the user chooses the
// Manager's home host, and changing it is a visible handover — the draft is
// shown, editable, before anything moves.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ManagerHomeGroup } from '../routes/settings/ManagerHomeGroup.js';
import { ErrorToasts } from '../components/ErrorToasts.js';
import { useUiStore } from '../stores/uiStore.js';
import { reportHost, clearHosts } from './presenceHelpers.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { DEFAULT_SHARED_SETTINGS } from '@patch/wire';

let home: string | null;
let calls: Array<{ url: string; method: string; body: unknown }>;
let draftAnswer: () => Response;
let putAnswer: () => Response;
let listAnswer: () => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderGroup(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ManagerHomeGroup />
      <ErrorToasts />
    </QueryClientProvider>,
  );
}

const select = (): HTMLSelectElement => screen.getByTestId('manager-home') as HTMLSelectElement;
const puts = () => calls.filter((c) => c.method === 'PUT');

beforeEach(() => {
  clearHosts();
  useUiStore.getState().clearToasts();
  reportHost('host-a', { hostName: 'laptop' });
  reportHost('host-b', { hostName: 'server', runsManager: false });
  home = 'host-a';
  calls = [];
  draftAnswer = () => json(200, { message: 'user: hello\n\nassistant: hi' });
  putAnswer = () => {
    const body = calls.at(-1)?.body as { hostId: string };
    home = body.hostId;
    return json(200, { hostId: body.hostId });
  };
  listAnswer = () => json(200, { path: '/srv/work', parent: '/srv', entries: [] });
  usePreferencesStore.setState({ preferences: DEFAULT_SHARED_SETTINGS, loaded: true });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (method === 'GET' && url === '/api/manager/home') {
        return Promise.resolve(json(200, { hostId: home }));
      }
      if (method === 'GET' && url.startsWith('/api/manager/home/draft')) {
        return Promise.resolve(draftAnswer());
      }
      if (method === 'PUT' && url === '/api/manager/home') return Promise.resolve(putAnswer());
      if (method === 'GET' && url.startsWith('/api/hosts/host-a/files')) {
        return Promise.resolve(listAnswer());
      }
      if (method === 'PATCH' && url === '/api/settings') {
        return Promise.resolve(
          json(200, { preferences: { ...DEFAULT_SHARED_SETTINGS, ...(body as object) } }),
        );
      }
      return new Promise<Response>(() => {});
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('Settings → Manager → Home', () => {
  it('shows the current home among every host', async () => {
    renderGroup();
    await waitFor(() => expect(select().value).toBe('host-a'));
    expect([...select().options].map((o) => o.textContent)).toEqual(['laptop', 'server']);
  });

  it('choosing a host shows the drafted handover and moves nothing until confirmed', async () => {
    renderGroup();
    await waitFor(() => expect(select().disabled).toBe(false));
    fireEvent.change(select(), { target: { value: 'host-b' } });
    const panel = await screen.findByTestId('manager-home-handover');
    expect(panel).toHaveTextContent('Move from laptop to server');
    expect(calls.some((c) => c.url === '/api/manager/home/draft?hostId=host-b')).toBe(true);
    const message = screen.getByTestId('manager-home-message') as HTMLTextAreaElement;
    expect(message.value).toBe('user: hello\n\nassistant: hi');
    expect(puts()).toEqual([]);

    // The user edits the message; what they approved is what is sent.
    fireEvent.change(message, { target: { value: 'carry on with the release' } });
    fireEvent.click(screen.getByTestId('manager-home-move'));
    await waitFor(() =>
      expect(puts().map((c) => c.body)).toEqual([
        { hostId: 'host-b', message: 'carry on with the release' },
      ]),
    );
    await waitFor(() => expect(screen.queryByTestId('manager-home-handover')).toBeNull());
    await waitFor(() => expect(select().value).toBe('host-b'));
  });

  it('cancel leaves the home where it was', async () => {
    renderGroup();
    await waitFor(() => expect(select().disabled).toBe(false));
    fireEvent.change(select(), { target: { value: 'host-b' } });
    await screen.findByTestId('manager-home-handover');
    fireEvent.click(screen.getByTestId('manager-home-cancel'));
    expect(screen.queryByTestId('manager-home-handover')).toBeNull();
    expect(select().value).toBe('host-a');
    expect(puts()).toEqual([]);
  });

  it("a refused move is said in the server's words and the panel stays open", async () => {
    putAnswer = () => json(409, { error: 'unknown_host', message: 'no host registered as host-b' });
    renderGroup();
    await waitFor(() => expect(select().disabled).toBe(false));
    fireEvent.change(select(), { target: { value: 'host-b' } });
    await screen.findByTestId('manager-home-handover');
    fireEvent.click(screen.getByTestId('manager-home-move'));
    await waitFor(() =>
      expect(useUiStore.getState().errors.map((e) => e.detail)).toContain(
        'no host registered as host-b',
      ),
    );
    expect(screen.getByTestId('manager-home-handover')).toBeInTheDocument();
  });
});

describe('Settings → Manager → Home → Folder', () => {
  it('shows the default folder until one is set', async () => {
    renderGroup();
    expect((await screen.findByTestId('manager-folder-path')).textContent).toBe(
      '~/.patch/threads/manager',
    );
  });

  it('checks the path on the home host before saving it', async () => {
    renderGroup();
    await waitFor(() => expect(select().value).toBe('host-a'));
    fireEvent.click(screen.getByTestId('manager-folder-change'));
    fireEvent.change(screen.getByTestId('manager-folder-input'), {
      target: { value: '/srv/work' },
    });
    fireEvent.click(screen.getByTestId('manager-folder-save'));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
        { managerFolder: '/srv/work' },
      ]),
    );
    expect(calls.some((c) => c.url.includes('/api/hosts/host-a/files?path=%2Fsrv%2Fwork'))).toBe(
      true,
    );
    await waitFor(() =>
      expect(screen.getByTestId('manager-folder-path').textContent).toBe('/srv/work'),
    );
  });

  it('refuses a path the host says is not a folder, with the host’s words, and saves nothing', async () => {
    listAnswer = () => json(404, { error: 'not_found', message: '/nope does not exist' });
    renderGroup();
    await waitFor(() => expect(select().value).toBe('host-a'));
    fireEvent.click(screen.getByTestId('manager-folder-change'));
    fireEvent.change(screen.getByTestId('manager-folder-input'), { target: { value: '/nope' } });
    fireEvent.click(screen.getByTestId('manager-folder-save'));
    expect((await screen.findByTestId('manager-folder-error')).textContent).toBe(
      '/nope does not exist',
    );
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});
