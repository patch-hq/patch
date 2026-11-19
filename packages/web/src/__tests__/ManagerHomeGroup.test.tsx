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

let home: string | null;
let calls: Array<{ url: string; method: string; body: unknown }>;
let draftAnswer: () => Response;
let putAnswer: () => Response;

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
