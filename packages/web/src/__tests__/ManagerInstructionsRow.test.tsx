// Settings → Manager → Prompts → Instructions: the Manager chat's CLAUDE.md on
// its home host, read and saved through host files over the opened version.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ManagerInstructionsRow,
  managerClaudeMdPath,
} from '../routes/settings/ManagerInstructionsRow.js';
import { reportHost, clearHosts } from './presenceHelpers.js';
import { usePresenceStore } from '../stores/presenceStore.js';

const PATH = '/home/me/.patch/threads/manager/CLAUDE.md';
let home: string | null;
let content: string;
let version: string;
let calls: Array<{ url: string; method: string; body: unknown }>;
let putAnswer: () => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderRow(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ManagerInstructionsRow />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  clearHosts();
  reportHost('host-a', { hostName: 'netcup' });
  usePresenceStore.getState().setHostOnline('host-a', true);
  home = 'host-a';
  content = '# Manager\n\nWatch every chat.';
  version = 'v1';
  calls = [];
  putAnswer = () => {
    const body = calls.at(-1)?.body as { content: string };
    content = body.content;
    version = 'v2';
    return json(200, { path: PATH, size: content.length, version });
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url === '/api/manager/home') return Promise.resolve(json(200, { hostId: home }));
      if (method === 'GET' && url.startsWith('/api/hosts/host-a/files/content')) {
        return Promise.resolve(json(200, { path: PATH, content, size: content.length, version }));
      }
      if (method === 'GET' && url.startsWith('/api/hosts/host-a/files')) {
        return Promise.resolve(json(200, { path: '/home/me', parent: '/home', entries: [] }));
      }
      if (method === 'PUT' && url === '/api/hosts/host-a/files/content') {
        return Promise.resolve(putAnswer());
      }
      return new Promise<Response>(() => {});
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('Settings → Manager → Instructions', () => {
  it('finds the file under the home host user’s home', () => {
    expect(managerClaudeMdPath('/home/me/')).toBe(PATH);
  });

  it('shows the Manager’s CLAUDE.md from its home host', async () => {
    renderRow();
    expect(await screen.findByTestId('manager-instructions-shown')).toHaveTextContent(
      'Watch every chat.',
    );
    const read = calls.find((c) => c.url.includes('/files/content'));
    expect(read?.url).toContain(encodeURIComponent(PATH));
  });

  it('saves an edit over the version it opened', async () => {
    renderRow();
    fireEvent.click(await screen.findByTestId('manager-instructions-edit'));
    fireEvent.change(screen.getByTestId('manager-instructions-text'), {
      target: { value: '# Manager\n\nAnswer questions yourself.' },
    });
    fireEvent.click(screen.getByTestId('manager-instructions-save'));
    await waitFor(() =>
      expect(screen.getByTestId('manager-instructions-shown')).toHaveTextContent(
        'Answer questions yourself.',
      ),
    );
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({
      path: PATH,
      content: '# Manager\n\nAnswer questions yourself.',
      baseVersion: 'v1',
    });
  });

  it('says so when the file changed on the host, and keeps the edit open', async () => {
    putAnswer = () => json(409, { error: 'conflict', message: 'changed' });
    renderRow();
    fireEvent.click(await screen.findByTestId('manager-instructions-edit'));
    fireEvent.change(screen.getByTestId('manager-instructions-text'), {
      target: { value: 'mine' },
    });
    fireEvent.click(screen.getByTestId('manager-instructions-save'));
    expect(await screen.findByTestId('manager-instructions-problem')).toHaveTextContent(
      'changed on the host',
    );
    expect(screen.getByTestId('manager-instructions-text')).toHaveValue('mine');
  });

  it('says the home host is offline rather than trying to read from it', async () => {
    usePresenceStore.getState().setHostOnline('host-a', false);
    renderRow();
    expect(await screen.findByTestId('manager-instructions-offline')).toHaveTextContent('netcup');
    expect(calls.some((c) => c.url.includes('/files'))).toBe(false);
  });

  it('asks for a home host when there is none', async () => {
    home = null;
    renderRow();
    expect(await screen.findByTestId('manager-instructions-no-home')).toBeInTheDocument();
  });
});
